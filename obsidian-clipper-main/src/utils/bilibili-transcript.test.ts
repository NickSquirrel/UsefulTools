import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	buildBilibiliPlayerParams,
	buildBilibiliPlayerWbiParams,
	buildBilibiliTranscript,
	extractBilibiliContent,
	extractBvid,
	getBilibiliCidFromUrl,
	getBilibiliPageNumber,
	isBilibiliViewDataForBvid,
	parseBilibiliSubtitleJson,
	pickBilibiliSubtitleTrack,
	selectBilibiliCid,
} from './bilibili-transcript';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('bilibili transcript utilities', () => {
	test('extracts BVID and page number from video URLs', () => {
		const url = 'https://www.bilibili.com/video/BV1TU411d78k/?p=2&cid=222&vd_source=test';

		expect(extractBvid(url)).toBe('BV1TU411d78k');
		expect(getBilibiliPageNumber(url)).toBe(2);
		expect(getBilibiliCidFromUrl(url)).toBe(222);
	});

	test('builds player request params from the selected bvid and cid only', () => {
		const params = buildBilibiliPlayerParams('BV1hN596zEas', 38368837657);

		expect(params).toBe('bvid=BV1hN596zEas&cid=38368837657');
		expect(params).not.toContain('aid=');
	});

	test('builds wbi player params from the fetched current aid and cid', () => {
		const params = buildBilibiliPlayerWbiParams(113384250999061, 38368837657);

		expect(params).toBe('aid=113384250999061&cid=38368837657');
		expect(params).not.toContain('bvid=');
	});

	test('accepts only view data that declares the requested bvid', () => {
		expect(isBilibiliViewDataForBvid({
			bvid: 'BV1mf4y1z7Db',
			cid: 300517375,
		}, 'BV1mf4y1z7Db')).toBe(true);
		expect(isBilibiliViewDataForBvid({
			bvid: 'BV1hN596zEas',
			cid: 38368837657,
		}, 'BV1mf4y1z7Db')).toBe(false);
		expect(isBilibiliViewDataForBvid({
			cid: 300517375,
		}, 'BV1mf4y1z7Db')).toBe(false);
	});

	test('uses current cid when it belongs to the current video pages', () => {
		const cid = selectBilibiliCid({
			pages: [
				{ page: 1, cid: 111 },
				{ page: 2, cid: 222 },
			],
		}, 1, 222);

		expect(cid).toBe(222);
	});

	test('falls back to page cid when preferred cid is from another video', () => {
		const cid = selectBilibiliCid({
			pages: [
				{ page: 1, cid: 111 },
				{ page: 2, cid: 222 },
			],
		}, 2, 999);

		expect(cid).toBe(222);
	});

	test('prefers Chinese CC tracks over AI tracks', () => {
		const track = pickBilibiliSubtitleTrack([
			{
				lan: 'ai-zh',
				lan_doc: 'AI Chinese',
				subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/ai.json',
			},
			{
				lan: 'en-US',
				lan_doc: 'English',
				subtitle_url: '//i0.hdslb.com/bfs/subtitle/en.json',
			},
			{
				lan: 'zh-Hans',
				lan_doc: 'Chinese',
				subtitle_url: '//i0.hdslb.com/bfs/subtitle/zh.json',
			},
		]);

		expect(track?.lan).toBe('zh-Hans');
	});

	test('falls back to Chinese AI when no CC track exists', () => {
		const track = pickBilibiliSubtitleTrack([
			{
				lan: 'en-US',
				lan_doc: 'English AI',
				subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/en.json',
			},
			{
				lan: 'ai-zh',
				lan_doc: 'Chinese AI',
				subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/zh.json',
			},
		]);

		expect(track?.lan).toBe('ai-zh');
	});

	test('honors configured language priority inside the same source type', () => {
		const track = pickBilibiliSubtitleTrack([
			{
				lan: 'zh-Hans',
				lan_doc: 'Chinese',
				subtitle_url: '//i0.hdslb.com/bfs/subtitle/zh.json',
			},
			{
				lan: 'en-US',
				lan_doc: 'English',
				subtitle_url: '//i0.hdslb.com/bfs/subtitle/en.json',
			},
		], 'en-US, zh-CN');

		expect(track?.lan).toBe('en-US');
	});

	test('parses subtitle JSON and builds timestamped transcript output', () => {
		const items = parseBilibiliSubtitleJson({
			body: [
				{ from: 1.2, to: 3.4, content: '  你好   世界  ' },
				{ from: 65, to: 67, content: 'Second line' },
				{ from: 'bad', content: 'ignored' },
			],
		});
		const transcript = buildBilibiliTranscript(items, {
			lan: 'zh-Hans',
			lan_doc: 'Chinese',
			subtitle_url: '//i0.hdslb.com/bfs/subtitle/zh.json',
		});

		expect(items).toEqual([
			{ from: 1.2, to: 3.4, content: '你好 世界' },
			{ from: 65, to: 67, content: 'Second line' },
		]);
		expect(transcript?.text).toContain('**0:01** - 你好 世界');
		expect(transcript?.text).toContain('**1:05** - Second line');
		expect(transcript?.html).toContain('class="bilibili transcript"');
		expect(transcript?.source).toBe('cc');
	});

	test('rejects fetched view data when it does not match the current URL bvid', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			json: async () => ({
				code: 0,
				data: {
					bvid: 'BV1hN596zEas',
					aid: 113384250999061,
					cid: 38368837657,
					pages: [{ page: 1, cid: 38368837657 }],
				},
			}),
		} as Response);
		const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const documentMock = {
			location: { href: 'https://www.bilibili.com/video/BV1mf4y1z7Db/' },
			title: 'Wrong inline state should not matter',
			querySelector: () => null,
		} as unknown as Document;

		const result = await extractBilibiliContent(
			documentMock,
			'https://www.bilibili.com/video/BV1mf4y1z7Db/'
		);

		expect(result).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toContain('bvid=BV1mf4y1z7Db');
		expect(warnMock).toHaveBeenCalledWith(
			'[Obsidian Clipper] Bilibili view data unavailable',
			expect.objectContaining({
				bvid: 'BV1mf4y1z7Db',
				fetchedBvid: 'BV1hN596zEas',
			})
		);
	});
});
