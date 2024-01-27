import { OPCodes, ConnectionState, HELLO_TIMEOUT, HEARTBEAT_MAX_RESUME_THRESHOLD, MAX_CONNECTION_RETRIES } from '~/constants';
import { request, strip, sleep } from '~/utilities';
import { createLogger } from '~/structures/logger';
import Webhook from '~/structures/webhook';
import Tokens from '~/structures/tokens';
import config from '~/config';
import WebSocket from 'ws';

class Client {
	logger = createLogger('WebSocket', 'Client');
	ws: WebSocket;

	user: User;
	guilds: Map<string, Guild>;

	helloTimeout: NodeJS.Timeout;
	heartbeatHandler: NodeJS.Timeout;

	sameGuildIntervals = new Map();

	pendingRestart: boolean;
	connectionStartTime: number;
	lastHeartbeatAckTime: number;
	heartbeatInterval: number;
	state: ConnectionState;
	sessionId: string;
	attempts: number;
	sequence: number;

	rotatedGuilds = [];

	constructor(
		public token: string,
		public tokens: Tokens
	) {
		this.createSocket();
	}

	onMessage(data: string) {
		try {
			const payload = JSON.parse(data);

			if (payload.s) {
				this.sequence = payload.s;
			}

			switch (payload.op) {
				case OPCodes.HELLO: {
					this.clearHelloTimeout();
					this.onHello(payload.d);
				} break;

				case OPCodes.HEARTBEAT_ACK: {
					this.logger.debug('⟶ PONG');
					this.lastHeartbeatAckTime = Date.now();
				} break;

				case OPCodes.INVALID_SESSION: {
					if (payload.d) {
						this.resume();
					} else {
						this.identify();
					}
				} break;

				case OPCodes.RECONNECT: {
					this.reconnect();
				} break;

				case OPCodes.DISPATCH: {
					this.onDispatch(payload);
				} break;
			}
		} catch (e) {
			this.logger.error('Failed to handle message:', e);
		}
	}

	onOpen() {
		this.logger.debug('Socket opened.');
		this.state = ConnectionState.CONNECTED;
		const now = Date.now();

		if (this.canResume) {
			this.resume();
		} else {
			this.identify();
		}

		this.lastHeartbeatAckTime = now;
	}

	async onClose(code: number, reason: Buffer) {
		this.logger.warn(strip(this.token) + ' Closed with code:', code, reason.toString('utf8'));
		this.state = ConnectionState.DISCONNECTED;
		this.stopHeartbeat();

		if (code === 4004) {
			this.logger.error(`Invalid token: ${strip(this.token)}`);
			this.tokens.invalidate(this.token);
		}

		if (code === 4444) return;
		if (this.shouldAttempt) {
			if ((this.attempts * 1000) !== 0) {
				this.logger.warn(`Waiting ${this.attempts * 1000}ms to reconnect...`);
			}

			setTimeout(() => {
				if (!this.shouldAttempt) return;
				this.logger.info(`Attempting to reconnect (attempt ${this.attempts}): ${strip(this.token)}`);
				this.createSocket();
			}, this.attempts * 1000);
		} else {
			this.logger.error(`Connected timed out ${this.attempts}, bye.`);
		}
	}

	get shouldAttempt() {
		const states = [ConnectionState.CONNECTED, ConnectionState.CONNECTING];
		if (~states.indexOf(this.state) || this.attempts === MAX_CONNECTION_RETRIES) return false;

		return true;
	}

	onError(error: Error) {
		this.logger.error('Encountered error:', error);
	}

	onDispatch(payload: any) {
		switch (payload.t) {
			case 'READY': {
				this.sessionId = payload.d.session_id;
				this.user = payload.d.user;
				this.guilds = new Map<string, Guild>();

				const guilds = payload.d.guilds;

				for (let i = 0; i < guilds.length; i++) {
					const guild = guilds[i];
					if (!guild.vanity_url_code) continue;

					this.guilds.set(guild.id, guild);
				}

				this.state = ConnectionState.CONNECTED;
				this.logger.success(`Logged in as ${this.user.username} with ${this.guilds.size} guilds.`, `Token: ${strip(this.token)}`);
				this.attempts = 0;
			} break;

			case 'GUILD_UPDATE': {
				const guild = payload.d;
				const persisted = this.guilds.get(guild.id);
				const interval = this.sameGuildIntervals.get(guild.id);

				this.guilds.set(guild.id, guild);

				if (persisted && persisted.vanity_url_code !== guild.vanity_url_code) {
					this.logger.info(`${guild.name} had a vanity change (${persisted.vanity_url_code} > ${guild.vanity_url_code ?? 'NONE'}).`);

					if (config.ignoreHostGuilds && ~config.guilds.indexOf(guild.id)) {
						return this.logger.info(`Ignoring vanity change for ${guild.name} as ignoreHostGuilds is toggled.`);
					}

					if (!interval || (interval && interval <= Date.now())) {
						this.sameGuildIntervals.delete(guild.id);
						this.snipe(persisted.vanity_url_code, guild.id);
					} else {
						this.logger.warn(`${guild.name} is on timeout for ${interval - Date.now()}ms. Ignoring vanity change.`);
					}
				}
			} break;

			case 'GUILD_DELETE': {
				const info = payload.d;
				const guild = this.guilds.get(info.guild_id);
				if (!guild) return;

				const interval = this.sameGuildIntervals.get(guild.id);

				this.guilds.delete(guild.id);
				this.logger.info(`${guild.name} got deleted or terminated.`);

				if (config.ignoreHostGuilds && ~config.guilds.indexOf(guild.id)) {
					return this.logger.info(`Ignoring guild deletion for ${guild.name} as ignoreHostGuilds is toggled.`);
				}

				if (!interval || (interval && interval <= Date.now())) {
					this.sameGuildIntervals.delete(guild.id);
					this.snipe(guild.vanity_url_code, guild.id);
				} else {
					this.logger.warn(`${guild.name} is on timeout for ${interval - Date.now()}ms. Ignoring vanity change.`);
				}
			} break;

			case 'GUILD_CREATE': {
				const guild = payload.d;
				if (!guild || !guild.vanity_url_code) return;

				this.logger.info(`Queued ${guild.name} for vanity sniping (discord.gg/${guild.vanity_url_code})`);
				this.guilds.set(guild.id, guild);
			} break;

			case 'RESUMED': {
				this.state = ConnectionState.CONNECTED;
				this.logger.success(`Logged in by resuming old session with ${this.guilds.size} guilds.`, `Token: ${strip(this.token)}`);
				this.attempts = 0;
			} break;
		}
	}

	onHello(payload: { heartbeat_interval: number; }) {
		this.logger.debug('Received HELLO.');
		this.heartbeatInterval = payload.heartbeat_interval;
		this.startHeartbeat();
	}

	clearHelloTimeout() {
		if (!this.helloTimeout) return;

		clearTimeout(this.helloTimeout);
		this.helloTimeout = null;
	}

	createSocket() {
		const states = [ConnectionState.CONNECTED, ConnectionState.CONNECTING];
		if (~states.indexOf(this.state)) return;
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(1000);


		this.attempts++;
		this.connectionStartTime = Date.now();

		this.helloTimeout = setTimeout(() => {
			const delay = Date.now() - this.connectionStartTime;
			this.ws.close(1000, `The connection timed out after ${delay}ms.`);
		}, HELLO_TIMEOUT);

		this.ws = new WebSocket(`wss://gateway.discord.gg/?v=${config.apiVersion}&encoding=json`);

		this.ws.on('message', this.onMessage.bind(this));
		this.ws.on('close', this.onClose.bind(this));
		this.ws.on('error', this.onError.bind(this));
		this.ws.on('open', this.onOpen.bind(this));
	}

	identify() {
		this.logger.debug('Sending IDENTIFY.');

		this.sequence = 0;
		this.sessionId = null;
		this.state = ConnectionState.IDENTIFYING;

		this.broadcast(OPCodes.IDENTIFY, { token: this.token, properties: config.properties });
	}

	resume() {
		this.logger.info('Attempting to resume old session...');
		this.state = ConnectionState.RESUMING;

		this.broadcast(OPCodes.RESUME, {
			token: this.token,
			session_id: this.sessionId,
			seq: this.sequence
		});
	}

	destroy(code: number = 1000) {
		this.ws.close(code);
		this.ws = null;
		this.sessionId = null;
	}

	reconnect() {
		this.logger.info('Reconnecting socket...');
		this.destroy(4444);

		this.state = ConnectionState.DISCOVERING;
		this.createSocket();
	}

	async heartbeat() {
		if (this.state === ConnectionState.CONNECTING) return;

		this.broadcast(OPCodes.HEARTBEAT, this.sequence ?? 0);
		this.logger.debug('⟵ PING');
	}

	startHeartbeat() {
		this.logger.debug('Starting heartbeat.');
		if (this.heartbeatHandler) this.stopHeartbeat();

		this.heartbeatHandler = setInterval(this.heartbeat.bind(this), this.heartbeatInterval);
	}

	stopHeartbeat() {
		clearInterval(this.heartbeatHandler);
		this.heartbeatHandler = null;
	}

	broadcast(op: OPCodes, data: any = {}) {
		if (this.ws.readyState !== WebSocket.OPEN) return;

		try {
			const stringified = JSON.stringify({ op, d: data });
			this.ws.send(stringified);
		} catch (error) {
			this.logger.error('Failed to send payload:', { data, error });
		}
	}

	async snipe(vanity: string, id: string, tries: number = 0) {
		this.logger.info('Attempting to snipe vanity:', vanity);

		if ((!config.rotateGuilds && !config.guilds.length) || (config.rotateGuilds && !config.guilds.length && !this.rotatedGuilds.length)) {
			this.logger.warn('No more guilds available to apply sniped vanities to. Exiting...');
			return process.exit(0);
		}

		if (!config.guilds.length && config.rotateGuilds) {
			this.logger.info('Rotating guilds as rotateGuilds is turned on.');
			config.guilds = this.rotatedGuilds;
		}

		const data = await request(`https://discord.com/api/v${config.apiVersion}/guilds/${config.guilds[0]}/vanity-url`, {
			method: 'PATCH',
			body: { code: vanity },
			headers: {
				'Authorization': this.token,
				'Content-Type': 'application/json',
				'X-Super-Properties': btoa(JSON.stringify(config.properties))
			}
		});


		const json = JSON.parse(await data.text());

		if (data.statusCode === 429 && json.retry_after) {
			this.logger.warn(`Ratelimited for ${json.retry_after}ms while trying to snipe vanity:`, vanity);
			await sleep(json.retry_after);

			if (config.retries < tries) {
				return this.snipe(vanity, id, tries++);
			} else {
				return this.logger.info(`Failed sniping ${vanity} after ${config.retries} attempts.`);
			}
		}

		if (json.code === vanity) {
			this.rotatedGuilds ??= [];
			this.rotatedGuilds.push(config.guilds.shift());
			this.logger.success(`Sniped vanity: ${vanity} (${(data as any).timeTaken.toFixed(3)}ms)`);
			Webhook.send(config.webhook, { content: `Sniped https://discord.gg/${vanity}` });
			if (config.exitOnSnipe) process.exit(0);
		} else {
			this.logger.warn(`Failed to snipe vanity: ${vanity} (${(data as any).timeTaken.toFixed(3)}ms) (${json.message})`);
		}

		const date = new Date();
		date.setMilliseconds(date.getMilliseconds() + config.sameGuildSnipeTimeout);
		this.sameGuildIntervals.set(id, date.getTime());
	}

	get canResume() {
		const threshold = (!this.lastHeartbeatAckTime || Date.now() - this.lastHeartbeatAckTime <= HEARTBEAT_MAX_RESUME_THRESHOLD);
		return this.sessionId != null && threshold;
	}
}

export default Client;