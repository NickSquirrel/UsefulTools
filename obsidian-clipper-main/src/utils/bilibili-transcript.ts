import { escapeHtml } from './string-utils';

const BILIBILI_PLAYER_API = 'https://api.bilibili.com/x/player/v2';
const BILIBILI_PLAYER_WBI_API = 'https://api.bilibili.com/x/player/wbi/v2';
const BILIBILI_VIEW_API = 'https://api.bilibili.com/x/web-interface/view';
const FETCH_TIMEOUT_MS = 6000;

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
}

interface FetchJsonResult {
	json: any;
	usedDirectRetry: boolean;
}

export interface BilibiliTranscript {
	html: string;
	text: string;
	languageCode: string;
	languageName: string;
	source: 'cc' | 'ai';
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

	const inlineViewData = getInlineViewData(document, bvid);
	const fetchedViewData = await fetchViewData(bvid);
	const viewData = (isBilibiliViewDataForBvid(fetchedViewData, bvid) ? fetchedViewData : null) || inlineViewData;
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

	const playerResult = await fetchPlayerData(bvid, cid);
	const playerData = playerResult.data;
	const tracks = playerData?.subtitle?.subtitles || [];
	const track = pickBilibiliSubtitleTrack(tracks, languagePriority);
	const transcript = track ? await fetchTranscript(track) : undefined;
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
			usedDirectRetry: playerResult.usedDirectRetry,
			trackId: track?.id || '',
			trackIdStr: track?.id_str || '',
			trackLanguage: track?.lan,
			trackName: track?.lan_doc,
			source: transcript.source,
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
	return pageMatch?.cid || viewData?.cid || viewData?.pages?.[0]?.cid;
}

function getPageByCid(viewData: BilibiliViewData | null, cid: number): number | undefined {
	return viewData?.pages?.find(item => item.cid === cid)?.page;
}

function cidBelongsToVideo(viewData: BilibiliViewData | null, cid: number): boolean {
	if (!viewData?.pages?.length) return true;
	return viewData.pages.some(page => page.cid === cid);
}

function parseCid(value: string | null | undefined): number | undefined {
	const cid = Number(value || '');
	return Number.isFinite(cid) && cid > 0 ? cid : undefined;
}

function getInlineViewData(document: Document, bvid?: string): BilibiliViewData | null {
	const scripts = Array.from(document.querySelectorAll('script'));
	for (const script of scripts) {
		const text = script.textContent || '';
		if (!text.includes('__INITIAL_STATE__')) continue;
		const jsonText = extractAssignedJson(text, '__INITIAL_STATE__');
		if (!jsonText) continue;
		try {
			const parsed = JSON.parse(jsonText);
			const videoData = parsed?.videoData || parsed?.videoInfo || parsed;
			if (bvid && videoData?.bvid !== bvid) {
				continue;
			}
			if (videoData?.cid || videoData?.pages?.length) {
				return videoData;
			}
		} catch {
			// ignore malformed inline state
		}
	}
	return null;
}

function extractAssignedJson(text: string, marker: string): string {
	const markerIndex = text.indexOf(marker);
	if (markerIndex === -1) return '';
	const startIndex = text.indexOf('{', markerIndex);
	if (startIndex === -1) return '';
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = startIndex; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === '{') {
			depth += 1;
		} else if (char === '}') {
			depth -= 1;
			if (depth === 0) {
				return text.slice(startIndex, i + 1);
			}
		}
	}
	return '';
}

async function fetchViewData(bvid: string): Promise<BilibiliViewData | null> {
	const url = addNoCacheParam(`${BILIBILI_VIEW_API}?bvid=${encodeURIComponent(bvid)}`);
	const json = await fetchJson(url, { credentials: 'include', referrer: 'https://www.bilibili.com/' });
	return json?.code === 0 ? json.data || null : null;
}

async function fetchPlayerData(bvid: string, cid: number): Promise<BilibiliPlayerFetchResult> {
	const params = buildBilibiliPlayerParams(bvid, cid);
	let fallback: BilibiliPlayerFetchResult = { data: null, usedDirectRetry: false };
	for (const endpoint of [BILIBILI_PLAYER_API, BILIBILI_PLAYER_WBI_API]) {
		const { json, usedDirectRetry } = await fetchJsonWithResult(
			addNoCacheParam(`${endpoint}?${params}`),
			{ credentials: 'include', referrer: 'https://www.bilibili.com/', cache: 'no-store' },
			isLoginGatedEmptySubtitleResponse
		);
		if (json?.code !== 0) continue;
		const data = json.data || null;
		if (!fallback.data) fallback = { data, endpoint, usedDirectRetry };
		if ((data?.subtitle?.subtitles || []).length > 0) return { data, endpoint, usedDirectRetry };
	}
	return fallback;
}

async function fetchTranscript(track: BilibiliSubtitleTrack): Promise<BilibiliTranscript | undefined> {
	if (!track.subtitle_url) return undefined;
	const subtitleUrl = normalizeSubtitleUrl(track.subtitle_url);
	const json = await fetchJson(subtitleUrl, { credentials: 'omit', referrer: 'https://www.bilibili.com/', cache: 'no-store' });
	const items = parseBilibiliSubtitleJson(json);
	return buildBilibiliTranscript(items, track);
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
	const proxied = await fetchJsonViaBackground(url, { ...options, credentials });
	if (proxied !== undefined) {
		if (!shouldRetryDirect?.(proxied)) {
			return { json: proxied, usedDirectRetry: false };
		}
		const direct = await fetchJsonDirect(url, { ...options, credentials });
		if (direct !== undefined) {
			return { json: direct, usedDirectRetry: true };
		}
		return { json: proxied, usedDirectRetry: false };
	}

	const direct = await fetchJsonDirect(url, { ...options, credentials });
	return { json: direct, usedDirectRetry: false };
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
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
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
