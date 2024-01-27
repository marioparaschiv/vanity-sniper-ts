import { createLogger } from '~/structures/logger';
import path from 'path';
import os from 'os';
import fs from 'fs';

class Tokens {
	paths: { unused: string; invalid: string; };
	logger = createLogger('User Tokens');

	invalid: string[] = [];
	tokens: string[] = [];
	used: string[] = [];

	constructor() {
		const state = path.join(__dirname, '..', '..', 'state');
		if (!fs.existsSync(state)) fs.mkdirSync(state);

		this.paths = {
			unused: path.join(state, 'tokens.txt'),
			invalid: path.join(state, 'invalidUserTokens.txt')
		};

		if (fs.existsSync(this.paths.unused)) {
			try {
				const content = fs.readFileSync(this.paths.unused, 'utf-8');
				const parsed = content.split(/\r?\n/).filter(Boolean);

				this.tokens = parsed;
			} catch (e) {
				this.logger.error('Failed to load tokens.txt:', e);
			}
		}

		if (fs.existsSync(this.paths.invalid)) {
			try {
				const content = fs.readFileSync(this.paths.invalid, 'utf-8');
				const parsed = content.split(/\r?\n/).filter(Boolean);

				this.invalid = parsed;
			} catch (e) {
				this.logger.error('Failed to load invalidTokens.txt:', e);
			}
		}
	}

	getNext() {
		const token = this.tokens[0];
		this.persist();

		return token;
	}

	getAll() {
		return this.tokens;
	}

	add(token: string) {
		this.tokens.push(token);
	}

	invalidate(token: string) {
		const idx = this.tokens.indexOf(token);
		if (idx > -1) this.tokens.splice(idx, 1);

		const idx2 = this.used.indexOf(token);
		if (idx2 > -1) this.used.splice(idx2, 1);

		this.invalid.push(token);
		this.persist();
	}

	persist() {
		fs.writeFileSync(this.paths.invalid, this.invalid.join(os.EOL));
		fs.writeFileSync(this.paths.unused, this.tokens.join(os.EOL));
	}
}

export default Tokens;