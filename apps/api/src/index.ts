import Fastify from 'fastify';
import cors from '@fastify/cors';
import serve from '@fastify/static';
import env from '@fastify/env';
import cookie from '@fastify/cookie';
import path, { join } from 'path';
import autoLoad from '@fastify/autoload';
import { asyncExecShell, asyncSleep, isDev, listSettings, prisma, version } from './lib/common';
import { scheduler } from './lib/scheduler';
import axios from 'axios';
import compareVersions from 'compare-versions';

declare module 'fastify' {
	interface FastifyInstance {
		config: {
			COOLIFY_APP_ID: string,
			COOLIFY_SECRET_KEY: string,
			COOLIFY_DATABASE_URL: string,
			COOLIFY_SENTRY_DSN: string,
			COOLIFY_IS_ON: string,
			COOLIFY_WHITE_LABELED: string,
			COOLIFY_WHITE_LABELED_ICON: string | null,
			COOLIFY_AUTO_UPDATE: string,
		};
	}
}

const port = isDev ? 3001 : 3000;
const host = '0.0.0.0';
const fastify = Fastify({
	logger: false,
	trustProxy: true
});
const schema = {
	type: 'object',
	required: ['COOLIFY_SECRET_KEY', 'COOLIFY_DATABASE_URL', 'COOLIFY_IS_ON'],
	properties: {
		COOLIFY_APP_ID: {
			type: 'string',
		},
		COOLIFY_SECRET_KEY: {
			type: 'string',
		},
		COOLIFY_DATABASE_URL: {
			type: 'string',
			default: 'file:../db/dev.db'
		},
		COOLIFY_SENTRY_DSN: {
			type: 'string',
			default: null
		},
		COOLIFY_IS_ON: {
			type: 'string',
			default: 'docker'
		},
		COOLIFY_WHITE_LABELED: {
			type: 'string',
			default: 'false'
		},
		COOLIFY_WHITE_LABELED_ICON: {
			type: 'string',
			default: null
		},
		COOLIFY_AUTO_UPDATE: {
			type: 'string',
			default: 'false'
		},

	}
};

const options = {
	schema,
	dotenv: true
};
fastify.register(env, options);
if (!isDev) {
	fastify.register(serve, {
		root: path.join(__dirname, './public'),
		preCompressed: true
	});
	fastify.setNotFoundHandler(async function (request, reply) {
		if (request.raw.url && request.raw.url.startsWith('/api')) {
			return reply.status(404).send({
				success: false
			});
		}
		return reply.status(200).sendFile('index.html');
	});
}
fastify.register(autoLoad, {
	dir: join(__dirname, 'plugins')
});
fastify.register(autoLoad, {
	dir: join(__dirname, 'routes')
});

fastify.register(cookie)
fastify.register(cors);
fastify.listen({ port, host }, async (err: any, address: any) => {
	if (err) {
		console.error(err);
		process.exit(1);
	}
	console.log(`Coolify's API is listening on ${host}:${port}`);
	await initServer();
	await scheduler.start('test');
	// await scheduler.start('cleanupPrismaEngines');
	// await scheduler.start('checkProxies');

	setInterval(async () => {
		if (!scheduler.workers.has('test')) {
			scheduler.run('test');
		}
	}, 2000)
	// setInterval(async () => {
	// 	if (!scheduler.workers.has('deployApplication')) {
	// 		scheduler.run('deployApplication');
	// 	}
	// }, 2000)

	// Check for update & if no build is running
	setInterval(async () => {
		const { isAutoUpdateEnabled } = await prisma.setting.findFirst();
		if (isAutoUpdateEnabled) {
			const currentVersion = version;
			const { data: versions } = await axios
				.get(
					`https://get.coollabs.io/versions.json`
					, {
						params: {
							appId: process.env['COOLIFY_APP_ID'] || undefined,
							version: currentVersion
						}
					})
			const latestVersion = versions['coolify'].main.version;
			const isUpdateAvailable = compareVersions(latestVersion, currentVersion);
			if (isUpdateAvailable === 1) {
				if (!scheduler.workers.has('deployApplication')) {
					await scheduler.run('autoUpdater')
				}
			}
		}
	}, isDev ? 5000 : 60000 * 15)

	// Cleanup storage
	setInterval(async () => {
		if (!scheduler.workers.has('deployApplication') && !scheduler.workers.has('cleanupStorage')) {
			await scheduler.run('cleanupStorage')
		}
	}, isDev ? 5000 : 60000 * 10)

	await getArch();
	await getIPAddress();
});
async function getIPAddress() {
	const { publicIpv4, publicIpv6 } = await import('public-ip')
	try {
		const settings = await listSettings();
		if (!settings.ipv4) {
			const ipv4 = await publicIpv4({ timeout: 2000 })
			await prisma.setting.update({ where: { id: settings.id }, data: { ipv4 } })
		}

		if (!settings.ipv6) {
			const ipv6 = await publicIpv6({ timeout: 2000 })
			await prisma.setting.update({ where: { id: settings.id }, data: { ipv6 } })
		}

	} catch (error) { }
}
async function initServer() {
	try {
		await asyncExecShell(`docker network create --attachable coolify`);
	} catch (error) { }
	try {
		const isOlder = compareVersions('3.8.1', version);
		if (isOlder === -1) {
			await prisma.build.updateMany({ where: { status: { in: ['running', 'queued'] } }, data: { status: 'failed' } });
		}
	} catch (error) { }
}
async function getArch() {
	try {
		const settings = await prisma.setting.findFirst({})
		if (settings && !settings.arch) {
			await prisma.setting.update({ where: { id: settings.id }, data: { arch: process.arch } })
		}
	} catch (error) { }
}


