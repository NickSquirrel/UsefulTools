import { escapeHtml } from './string-utils';

const BILIBILI_PLAYER_API = 'https://api.bilibili.com/x/player/v2';
const BILIBILI_PLAYER_WBI_API = 'https://api.bilibili.com/x/player/wbi/v2';
const BILIBILI_VIEW_API = 'https://api.bilibili.com/x/web-interface/view';
const FETCH_TIMEOUT_MS = 6000;
type FetchJsonSource = 'page' | 'background' | 'direct' | 'none';

const DEFAULT_LANGUAGE_PRIORITY = [
	'zh-Hans',
	'zh-CN',
	'zh',
	'zh-Hant',
	'zh-TW',
	'zh-HK',
	'ai-zh',
	'ai-zh-Hans',
	'ai-zh-Hant',
	'en',
	'en-US',
];

interface BilibiliViewData {
	aid?: number;
	bvid?: string;
	cid?: number;
	title?: string;
	desc?: string;
	pic?: string;
	pubdate?: number;
	owner?: {
		name?: string;
	};
	pages?: Array<{
		cid?: number;
		page?: number;
		part?: string;
	}>;
	subtitle?: {
		list?: BilibiliSubtitleTrack[];
	};
}

interface BilibiliPlayerData {
	need_login_subtitle?: boolean;
	subtitle?: {
		subtitles?: BilibiliSubtitleTrack[];
	};
}

interface BilibiliPlayerFetchResult {
	data: BilibiliPlayerData | null;
	endpoint?: string;
	requestParams?: string;
	fetchSource: FetchJsonSource;
	usedDirectRetry: boolean;
}

export interface BilibiliSubtitleTrack {
	id?: number;
	id_str?: string;
	lan?: string;
	lan_doc?: string;
	subtitle_url?: string;
	author_mid?: number;
	ai_type?: number;
	ai_status?: number;
}

interface BilibiliSubtitleItem {
	from: number;
	to?: number;
	content: string;
}

interface FetchJsonOptions {
	credentials?: RequestCredentials;
	referrer?: string;
	cache?: RequestCache;
	preferPage?: boolean;
}

interface FetchJsonResult {
	json: any;
	source: FetchJsonSource;
	usedDirectRetry: boolean;
}

export interface BilibiliTranscript {
	html: string;
	text: string;
	languageCode: string;
	languageName: string;
	source: 'cc' | 'ai';
	subtitleFetchSource?: FetchJsonSource;
}

export interface BilibiliExtraction {
	content?: string;
	title?: string;
	author?: string;
	description?: string;
	image?: string;
	published?: string;
	site?: string;
	language?: string;
	variables: Record<string, string>;
}

export function isBilibiliVideoUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.hostname.endsWith('bilibili.com') && parsed.pathname.includes('/video/');
	} catch {
		return false;
	}
}

export function extractBvid(url: string): string {
	const match = url.match(/\/video\/(BV[a-zA-Z0-9]+)/) || url.match(/\b(BV[a-zA-Z0-9]{8,})\b/);
	return match?.[1] || '';
}

export function getBilibiliPageNumber(url: string): number {
	try {
		const parsed = new URL(url);
		const page = Number(parsed.searchParams.get('p') || '1');
		return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
	} catch {
		return 1;
	}
}

export function getBilibiliCidFromUrl(url: string): number | undefined {
	try {
		const parsed = new URL(url);
		return parseCid(parsed.searchParams.get('cid'));
	} catch {
		return undefined;
	}
}

export function isAiSubtitleTrack(track: BilibiliSubtitleTrack): boolean {
	const language = normalizeLanguageCode(track.lan || '');
	const url = track.subtitle_url || '';
	return language.startsWith('ai-')
		|| /\/ai[_-]?subtitle\//i.test(url)
		|| typeof track.ai_type === 'number' && track.ai_type > 0;
}

export function pickBilibiliSubtitleTrack(
	tracks: BilibiliSubtitleTrack[],
	languagePriority = ''
): BilibiliSubtitleTrack | undefined {
	const usableTracks = dedupeTracks(tracks).filter(track => !!track.subtitle_url);
	const ccTracks = usableTracks.filter(track => !isAiSubtitleTrack(track));
	const aiTracks = usableTracks.filter(track => isAiSubtitleTrack(track));
	return pickByLanguage(ccTracks, languagePriority)
		|| pickByLanguage(aiTracks, languagePriority);
}

export function buildBilibiliPlayerParams(bvid: string, cid: number): string {
	return [
		`bvid=${encodeURIComponent(bvid)}`,
		`cid=${encodeURIComponent(String(cid))}`,
	].join('&');
}

export function buildBilibiliPlayerWbiParams(aid: number, cid: number): string {
	return [
		`aid=${encodeURIComponent(String(aid))}`,
		`cid=${encodeURIComponent(String(cid))}`,
	].join('&');
}

export function isBilibiliViewDataForBvid(viewData: BilibiliViewData | null, bvid: string): boolean {
	return !!viewData?.bvid && viewData.bvid === bvid;
}

export function parseBilibiliSubtitleJson(data: any): BilibiliSubtitleItem[] {
	const body = Array.isArray(data?.body) ? data.body : [];
	return body
		.map((item: any) => ({
			from: Number(item?.from),
			to: Number(item?.to),
			content: String(item?.content || '').replace(/\s+/g, ' ').trim(),
		}))
		.filter((item: BilibiliSubtitleItem) => Number.isFinite(item.from) && !!item.content);
}

export function buildBilibiliTranscript(
	items: BilibiliSubtitleItem[],
	track: BilibiliSubtitleTrack
): BilibiliTranscript | undefined {
	if (items.length === 0) return undefined;

	const htmlParts: string[] = [];
	const textParts: string[] = [];

	for (const item of items) {
		const timestamp = formatTimestamp(item.from);
		htmlParts.push(`<p class="transcript-segment"><strong><span class="timestamp" data-timestamp="${item.from}">${timestamp}</span></strong> - ${escapeHtml(item.content)}</p>`);
		textParts.push(`**${timestamp}** - ${item.content}`);
	}

	return {
		html: `<div class="bilibili transcript">\n<h2>Transcript</h2>\n${htmlParts.join('\n')}\n</div>`,
		text: textParts.join('\n'),
		languageCode: track.lan || '',
		languageName: track.lan_doc || '',
		source: isAiSubtitleTrack(track) ? 'ai' : 'cc',
	};
}

export async function extractBilibiliContent(
	document: Document,
	url: string,
	languagePriority = ''
): Promise<BilibiliExtraction | null> {
	if (!isBilibiliVideoUrl(url)) return null;

	const bvid = extractBvid(url);
	if (!bvid) return null;

	const fetchedViewData = await fetchViewData(bvid, url);
	const viewData = isBilibiliViewDataForBvid(fetchedViewData, bvid) ? fetchedViewData : null;
	if (!viewData) {
		console.warn('[Obsidian Clipper] Bilibili view data unavailable', {
			bvid,
			url,
			locationUrl: document.location?.href || '',
			fetchedBvid: fetchedViewData?.bvid || '',
		});
		return null;
	}
	const page = getBilibiliPageNumber(url);
	const preferredCid = getBilibiliCidFromUrl(url);
	const cid = selectBilibiliCid(viewData, page, preferredCid);
	if (!cid) return null;
	const selectedPage = getPageByCid(viewData, cid) || page;

	const playerResult = await fetchPlayerData(bvid, cid, viewData.aid, url);
	const playerData = playerResult.data;
	const tracks = playerData?.subtitle?.subtitles || [];
	const track = pickBilibiliSubtitleTrack(tracks, languagePriority);
	const transcript = track ? await fetchTranscript(track, url) : undefined;
	if (!transcript) {
		console.warn('[Obsidian Clipper] Bilibili transcript unavailable', {
			bvid,
			cid,
			url,
			locationUrl: document.location?.href || '',
			viewBvid: viewData.bvid || '',
			viewAid: viewData.aid || '',
			viewCid: viewData.cid || '',
			playerEndpoint: playerResult.endpoint || '',
			playerRequestParams: playerResult.requestParams || '',
			playerFetchSource: playerResult.fetchSource,
			usedDirectRetry: playerResult.usedDirectRetry,
			trackCount: tracks.length,
			playerTrackCount: playerData?.subtitle?.subtitles?.length || 0,
			needLoginSubtitle: playerData?.need_login_subtitle,
			selectedTrackLanguage: track?.lan,
			hasSelectedTrackUrl: !!track?.subtitle_url,
		});
	} else {
		console.info('[Obsidian Clipper] Bilibili transcript selected', {
			bvid,
			cid,
			selectedPage,
			url,
			locationUrl: document.location?.href || '',
			viewBvid: viewData.bvid || '',
			viewAid: viewData.aid || '',
			viewCid: viewData.cid || '',
			playerEndpoint: playerResult.endpoint || '',
			playerRequestParams: playerResult.requestParams || '',
			playerFetchSource: playerResult.fetchSource,
			usedDirectRetry: playerResult.usedDirectRetry,
			trackId: track?.id || '',
			trackIdStr: track?.id_str || '',
			trackLanguage: track?.lan,
			trackName: track?.lan_doc,
			source: transcript.source,
			subtitleFetchSource: transcript.subtitleFetchSource || '',
			subtitleUrl: track?.subtitle_url || '',
			preview: transcript.text.slice(0, 120),
		});
	}

	const content = buildVideoContent(url, bvid, cid, selectedPage, viewData, transcript);
	const title = viewData?.title || getMetaContent(document, 'og:title') || document.title || '';
	const description = viewData?.desc || getMetaContent(document, 'og:description') || '';
	const author = viewData?.owner?.name || '';

	const variables: Record<string, string> = {
		videoId: bvid,
		bilibiliBvid: bvid,
		bilibiliCid: String(cid),
		bilibiliAid: viewData.aid ? String(viewData.aid) : '',
	};
	if (transcript?.text) {
		variables.transcript = transcript.text;
		variables.transcriptSource = transcript.source;
		variables.bilibiliSubtitleUrl = track?.subtitle_url || '';
	}
	if (transcript?.languageCode) variables.language = transcript.languageCode;
	if (transcript?.languageName) variables.transcriptLanguage = transcript.languageName;

	return {
		content,
		title,
		author,
		description,
		image: viewData?.pic || getMetaContent(document, 'og:image') || '',
		published: viewData?.pubdate ? new Date(viewData.pubdate * 1000).toISOString() : '',
		site: 'Bilibili',
		language: transcript?.languageCode || '',
		variables,
	};
}

function dedupeTracks(tracks: BilibiliSubtitleTrack[]): BilibiliSubtitleTrack[] {
	const seen = new Set<string>();
	const result: BilibiliSubtitleTrack[] = [];
	for (const track of tracks) {
		const key = track.subtitle_url || track.id_str || String(track.id || '');
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(track);
	}
	return result;
}

function pickByLanguage(
	tracks: BilibiliSubtitleTrack[],
	languagePriority: string
): BilibiliSubtitleTrack | undefined {
	if (tracks.length === 0) return undefined;
	const priorities = buildLanguagePriority(languagePriority);
	for (const preferred of priorities) {
		const match = tracks.find(track => languageMatches(track.lan || '', preferred));
		if (match) return match;
	}
	return tracks[0];
}

function buildLanguagePriority(languagePriority: string): string[] {
	const configured = languagePriority
		.split(',')
		.map(code => normalizeLanguageCode(code))
		.filter(Boolean);
	return [...configured, ...DEFAULT_LANGUAGE_PRIORITY]
		.map(code => normalizeLanguageCode(code))
		.filter((code, index, list) => list.indexOf(code) === index);
}

function languageMatches(languageCode: string, preferred: string): boolean {
	const code = normalizeLanguageCode(languageCode);
	const pref = normalizeLanguageCode(preferred);
	if (!code || !pref) return false;
	if (code === pref) return true;

	const codeWithoutAi = code.replace(/^ai-/, '');
	const prefWithoutAi = pref.replace(/^ai-/, '');
	if (codeWithoutAi === prefWithoutAi) return true;

	return codeWithoutAi.split('-')[0] === prefWithoutAi.split('-')[0];
}

function normalizeLanguageCode(code: string): string {
	return code.trim().replace(/_/g, '-').toLowerCase();
}

function formatTimestamp(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (h > 0) {
		return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	}
	return `${m}:${String(s).padStart(2, '0')}`;
}

export function selectBilibiliCid(
	viewData: BilibiliViewData | null,
	page: number,
	preferredCid?: number
): number | undefined {
	if (preferredCid && cidBelongsToVideo(viewData, preferredCid)) {
		return preferredCid;
	}
	return getCidByPage(viewData, page);
}

function getCidByPage(viewData: BilibiliViewData | null, page: number): number | undefined {
	const pageMatch = viewData?.pages?.find(item => item.page === page);
	if (pageMatch?.cid) return pageMatch.cid;
	if (page <= 1 && viewData?.cid && cidBelongsToVideo(viewData, viewData.cid)) return viewData.cid;
	return viewData?.pages?.[0]?.cid;
}

function getPageByCid(viewData: BilibiliViewData | null, cid: number): number | undefined {
	return viewData?.pages?.find(item => item.cid === cid)?.page;
}

function cidBelongsToVideo(viewData: BilibiliViewData | null, cid: number): boolean {
	if (!viewData?.pages?.length) return viewData?.cid === cid;
	return viewData.pages.some(page => page.cid === cid);
}

function parseCid(value: string | null | undefined): number | undefined {
	const cid = Number(value || '');
	return Number.isFinite(cid) && cid > 0 ? cid : undefined;
}

async function fetchViewData(bvid: string, pageUrl: string): Promise<BilibiliViewData | null> {
	const url = addNoCacheParam(`${BILIBILI_VIEW_API}?bvid=${encodeURIComponent(bvid)}`);
	const json = await fetchJson(url, {
		credentials: 'include',
		referrer: pageUrl,
		cache: 'no-store',
		preferPage: true,
	});
	return json?.code === 0 ? json.data || null : null;
}

async function fetchPlayerData(
	bvid: string,
	cid: number,
	aid: number | undefined,
	pageUrl: string
): Promise<BilibiliPlayerFetchResult> {
	const requests = [
		...(aid ? [{
			endpoint: BILIBILI_PLAYER_WBI_API,
			params: buildBilibiliPlayerWbiParams(aid, cid),
		}] : []),
		{
			endpoint: BILIBILI_PLAYER_API,
			params: buildBilibiliPlayerParams(bvid, cid),
		},
		...(aid ? [] : [{
			endpoint: BILIBILI_PLAYER_WBI_API,
			params: buildBilibiliPlayerParams(bvid, cid),
		}]),
	];
	let fallback: BilibiliPlayerFetchResult = { data: null, fetchSource: 'none', usedDirectRetry: false };
	for (const request of requests) {
		const { json, source, usedDirectRetry } = await fetchJsonWithResult(
			addNoCacheParam(`${request.endpoint}?${request.params}`),
			{ credentials: 'include', referrer: pageUrl, cache: 'no-store', preferPage: true },
			isLoginGatedEmptySubtitleResponse
		);
		if (json?.code !== 0) continue;
		const data = json.data || null;
		if (!fallback.data) {
			fallback = {
				data,
				endpoint: request.endpoint,
				requestParams: request.params,
				fetchSource: source,
				usedDirectRetry,
			};
		}
		if ((data?.subtitle?.subtitles || []).length > 0) {
			return {
				data,
				endpoint: request.endpoint,
				requestParams: request.params,
				fetchSource: source,
				usedDirectRetry,
			};
		}
	}
	return fallback;
}

async function fetchTranscript(track: BilibiliSubtitleTrack, pageUrl: string): Promise<BilibiliTranscript | undefined> {
	if (!track.subtitle_url) return undefined;
	const subtitleUrl = normalizeSubtitleUrl(track.subtitle_url);
	const { json, source } = await fetchJsonWithResult(subtitleUrl, {
		credentials: 'omit',
		referrer: pageUrl,
		cache: 'no-store',
		preferPage: true,
	});
	const items = parseBilibiliSubtitleJson(json);
	const transcript = buildBilibiliTranscript(items, track);
	if (transcript) transcript.subtitleFetchSource = source;
	return transcript;
}

function normalizeSubtitleUrl(url: string): string {
	if (url.startsWith('//')) return `https:${url}`;
	return url;
}

async function fetchJson(url: string, options: FetchJsonOptions = {}): Promise<any> {
	return (await fetchJsonWithResult(url, options)).json;
}

async function fetchJsonWithResult(
	url: string,
	options: FetchJsonOptions = {},
	shouldRetryDirect?: (json: any) => boolean
): Promise<FetchJsonResult> {
	const credentials = options.credentials || 'same-origin';
	let deferredPageJson: any;
	let hasDeferredPageJson = false;
	if (options.preferPage) {
		const pageJson = await fetchJsonViaPage(url, { ...options, credentials });
		if (pageJson !== undefined && !shouldRetryDirect?.(pageJson)) {
			return { json: pageJson, source: 'page', usedDirectRetry: false };
		}
		if (pageJson !== undefined) {
			deferredPageJson = pageJson;
			hasDeferredPageJson = true;
		}
	}

	const proxied = await fetchJsonViaBackground(url, { ...options, credentials });
	if (proxied !== undefined) {
		if (!shouldRetryDirect?.(proxied)) {
			return { json: proxied, source: 'background', usedDirectRetry: false };
		}
		const direct = await fetchJsonDirect(url, { ...options, credentials });
		if (direct !== undefined) {
			return { json: direct, source: 'direct', usedDirectRetry: true };
		}
		return { json: proxied, source: 'background', usedDirectRetry: false };
	}

	const direct = await fetchJsonDirect(url, { ...options, credentials });
	if (direct === undefined && hasDeferredPageJson) {
		return { json: deferredPageJson, source: 'page', usedDirectRetry: false };
	}
	return { json: direct, source: direct === undefined ? 'none' : 'direct', usedDirectRetry: false };
}

async function fetchJsonDirect(url: string, options: FetchJsonOptions & { credentials: RequestCredentials }): Promise<any | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			credentials: options.credentials,
			referrer: options.referrer,
			cache: options.cache,
			headers: {
				'Accept': 'application/json,text/plain,*/*',
			},
			signal: controller.signal,
		});
		if (!response.ok) return undefined;
		return await response.json();
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchJsonViaBackground(url: string, options: FetchJsonOptions): Promise<any | undefined> {
	if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
		return undefined;
	}

	try {
		const response = await new Promise<any>((resolve) => {
			chrome.runtime.sendMessage({
				action: 'fetchProxy',
				url,
				options: {
					credentials: options.credentials,
					referrer: options.referrer,
					cache: options.cache,
					headers: {
						'Accept': 'application/json,text/plain,*/*',
					},
				},
			}, resolve);
		});

		if (!response || !response.ok || !response.text) {
			return undefined;
		}
		return JSON.parse(response.text);
	} catch {
		return undefined;
	}
}

async function fetchJsonViaPage(url: string, options: FetchJsonOptions & { credentials: RequestCredentials }): Promise<any | undefined> {
	if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
		return undefined;
	}

	try {
		const response = await new Promise<any>((resolve) => {
			chrome.runtime.sendMessage({
				action: 'pageFetch',
				url,
				options: {
					credentials: options.credentials,
					referrer: options.referrer,
					cache: options.cache,
					headers: {
						'Accept': 'application/json,text/plain,*/*',
					},
				},
			}, resolve);
		});

		if (!response || !response.ok || !response.text) {
			return undefined;
		}
		return JSON.parse(response.text);
	} catch {
		return undefined;
	}
}

function isLoginGatedEmptySubtitleResponse(json: any): boolean {
	const data = json?.data;
	return json?.code === 0
		&& data?.need_login_subtitle === true
		&& (data?.subtitle?.subtitles || []).length === 0;
}

function addNoCacheParam(url: string): string {
	const separator = url.includes('?') ? '&' : '?';
	return `${url}${separator}_=${Date.now()}`;
}

function buildVideoContent(
	pageUrl: string,
	bvid: string,
	cid: number,
	page: number,
	viewData: BilibiliViewData | null,
	transcript?: BilibiliTranscript
): string {
	const iframeUrl = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(String(cid))}&page=${encodeURIComponent(String(page))}`;
	const title = viewData?.title || '';
	const description = viewData?.desc || '';
	const parts = [
		`<iframe width="560" height="315" src="${iframeUrl}" title="${escapeHtml(title || 'Bilibili video player')}" frameborder="0" allowfullscreen></iframe>`,
		description ? `<p>${escapeHtml(description).replace(/\n/g, '<br>')}</p>` : '',
		transcript?.html || '',
		`<p><a href="${escapeHtml(pageUrl)}">${escapeHtml(pageUrl)}</a></p>`,
	];
	return parts.filter(Boolean).join('\n');
}

function getMetaContent(document: Document, property: string): string {
	return document.querySelector(`meta[property="${property}"]`)?.getAttribute('content') || '';
}
