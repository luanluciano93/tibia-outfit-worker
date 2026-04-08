/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */


import { getParams } from './get_params';
import {createColorizedOutfit, createAnimatedGIF} from './outfit_renderer';
import {parseTar} from './tar';

const tarCache = new Map();

async function loadFileStaticAsset(env, path) {
	const response = await env.ASSETS.fetch(
		new Request(`https://static.local/${path}`)
	);
	if (!response.ok) return null;

	return await response.arrayBuffer();
}

async function getTarPack(env, id) {
	if (tarCache.has(id)) {
		return tarCache.get(id);
	}

	const buffer = await loadFileStaticAsset(env, `outfits_tar/${id}.tar`);
	if (!buffer) return null;

	const parsed = parseTar(buffer);
	tarCache.set(id, parsed);

	return parsed;
}

function buildCacheKey(url, params) {
	// v4 = renderer version (bump when logic changes)
	const keyString = `v5_${params.id}_${params.walk}_${params.addons}_${params.head}_${params.body}_${params.legs}_${params.feet}_${params.mounthead}_${params.mountbody}_${params.mountlegs}_${params.mountfeet}_${params.mount}_${params.direction}_${params.animation}_${params.rotate ? 1 : 0}_${params.animate ? 1 : 0}`;

	const cacheUrl = `${url.origin}/_outfit_cache/${keyString}`;

	return new Request(cacheUrl, {
		method: "GET",
	});
}

let allowedHostsCache = null;

function getAllowedHosts(env) {
	if (!allowedHostsCache) {
		allowedHostsCache = new Set(
			(env.ALLOWED_REFERERS || "")
				.split(",")
				.map(h => h.trim())
				.filter(Boolean)
		);
	}
	return allowedHostsCache;
}

function isAllowedReferer(request, env) {
	const referer = request.headers.get("referer");
	if (!referer) return true; // allow no referer

	if (!env.ALLOWED_REFERERS) {
		return true;
	}

	const host = new URL(referer).hostname;
	return getAllowedHosts(env).has(host);
}
export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (!isAllowedReferer(request, env)) {
			return new Response("Alien detected", { status: 400 })
		}

		const params = getParams(url);
		if (!params) {
			return new Response("Invalid parameters", { status: 400 })
		}

		const cache = caches.default;
		const cacheKey = buildCacheKey(url, params);

		const cached = await cache.match(cacheKey);
		if (cached) {
			return cached;
		}

		const [outfitPack, mountPack] = await Promise.all([
			getTarPack(env, params.id),
			params.mount ? getTarPack(env, params.mount) : null,
		]);

		if (!outfitPack) {
			return new Response("Outfit not found", { status: 400 })
		}

		if (params.mount && !mountPack) {
			return new Response("Mount not found", { status: 400 })
		}

		let response = null;
		if (!params.animate) {
			const image = await createColorizedOutfit(params, outfitPack, mountPack);
			if (image) {
				response = new Response(image, {
					headers: {
						"Content-Type": "image/png",
						"Cache-Control": "public, max-age=2592000, immutable"
					}
				})
			}
		} else {
			const image = await createAnimatedGIF(params, outfitPack, mountPack);
			if (image) {
				response = new Response(image, {
					headers: {
						"Content-Type": "image/gif",
						"Cache-Control": "public, max-age=2592000, immutable"
					}
				})
			}
		}

		if (response) {
			ctx.waitUntil(cache.put(cacheKey, response.clone()));
			return response;
		}

		return new Response('Something strange happened', { status: 400 });
	},
};
