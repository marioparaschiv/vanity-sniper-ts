import sourcemaps from 'source-map-support';
sourcemaps.install();

import Client from '~/structures/client';
import Tokens from '~/structures/tokens';

const tokens = new Tokens();

for (const token of tokens.getAll()) {
	new Client(token, tokens);
}