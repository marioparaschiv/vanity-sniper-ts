import { RESTPostAPIWebhookWithTokenJSONBody } from 'discord-api-types/v10';
import { createLogger } from '~/structures/logger';
import { splitMessage } from '~/utilities';
import FormData from 'form-data';
import { inspect } from 'util';

interface File {
	path: string;
	mimeType: string;
	buffer: Buffer;
	name: string;
}

class Webhook {
	logger = createLogger('Webhook');

	async send(url: string, message: RESTPostAPIWebhookWithTokenJSONBody, files?: File[]) {
		if (message.content.length > 2000) {
			const chunks = splitMessage(message.content);

			for (const chunk of chunks) {
				await this.send(url, { ...message, content: chunk });
			}

			if (files.length) {
				await this.send(url, { ...message, content: '' }, files);
			}

			return;
		}

		try {
			const form = new FormData();

			form.append('payload_json', JSON.stringify(message));

			if (files?.length) {
				for (let i = 1; i < files.length + 1; i++) {
					const file = files[i - 1];
					const field = 'file' + i;

					form.append(field, file.buffer, { filename: file.name });
				}
			}

			return await new Promise((resolve, reject) => {
				form.submit(url, (err, res) => {
					if (err) {
						(err);
						throw err;
					}

					res.on('data', data => {
						if (data) {
							const res = JSON.parse(data);
							this.logger.debug('Webhook response:\n');
							this.logger.debug(res);
						}
					});

					res.on('end', resolve);
					res.on('error', reject);

					this.logger.debug(`Forwarding payload to webhook.`);
					this.logger.debug(inspect({ url, message, files }));
					res.resume();
				});
			});
		} catch (e) {
			this.logger.error('Failed to send to webhook!\n');
			this.logger.error(inspect(e));
			this.logger.error(inspect({ url, message }));
		}
	};
}

export default new Webhook();