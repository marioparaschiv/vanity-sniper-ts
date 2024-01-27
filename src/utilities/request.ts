import centra from 'centra';

interface Options {
	body?: Record<string, any>;
	headers?: Record<string, string>;
	method?: string;
}

async function request(url: string, options: Options) {
	const res = centra(url, options.method ?? 'GET');

	for (const header in options.headers ?? {}) {
		res.header(header, options.headers[header]);
	}

	if (options.body) res.body(options.body, 'json');

	const data = await res.send();

	return data;
}

export default request;