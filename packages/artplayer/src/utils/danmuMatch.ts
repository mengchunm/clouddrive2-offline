import type { SearchAnime } from "../danmu-api";

function hasCJK(value: string): boolean {
	return /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(
		value,
	);
}

function cleanTitle(title: string): string {
	return title
		.replace(/[～~「」『』《》“”"'‘’]/g, " ")
		.replace(/第[一二三四五六七八九十百千\d]+季/g, "")
		.replace(/\d+(st|nd|rd|th)\s*Season/gi, "")
		.replace(/[-_.]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function extractTitle(fileName: string): string {
	let name = fileName.replace(/\.[^.]+$/, "");

	if (name.includes("★")) {
		const starParts = name
			.split("★")
			.map((part) => part.trim())
			.filter(Boolean);
		const titlePart = starParts
			.slice(1)
			.find(
				(part) =>
					hasCJK(part) &&
					!/^\d+$/.test(part) &&
					!/1080|720|1920|AVC|AAC|MP4/i.test(part),
			);
		if (titlePart) {
			name =
				titlePart
					.replace(/\s+[A-Z][a-z]+(?:\s+[a-z]+)*(?:\s+[A-Z][a-z]+)*\s*$/i, "")
					.trim() || titlePart;
			name = name.replace(/\s+\d{1,3}\s*$/, "").trim();
			return cleanTitle(name);
		}
	}

	const fullWidthTags = name.match(/【[^【】]*】/g);
	if (fullWidthTags && fullWidthTags.length >= 3) {
		const skipPatterns =
			/字幕|新番|月新|合集|GB|BIG5|MP4|MKV|1080|720|1920|1280|練習組|练习组/i;
		for (const tag of fullWidthTags) {
			const content = tag.slice(1, -1).trim();
			if (
				hasCJK(content) &&
				!skipPatterns.test(content) &&
				!/^\d+$/.test(content)
			) {
				name = content;
				break;
			}
		}
	}

	if (name.includes("_") && hasCJK(name)) {
		const parts = name
			.split("_")
			.map((part) => part.trim())
			.filter(Boolean);
		const cjkTitle = parts.find(
			(part) =>
				hasCJK(part) && !/字幕|练习|偶像/.test(part) && part.length >= 2,
		);
		if (cjkTitle) name = cjkTitle;
	}

	if (/^\s*[[【]/.test(name)) {
		name = name.replace(/^(\s*[[【][^\]】]*[\]】]\s*)+/, "").trim();
	}
	name = name.replace(/【([^】]*)】/g, "$1").trim();

	if (name.includes("/")) {
		const parts = name.split(/\s*\/\s*/);
		const cjkPart = parts.find((part) => hasCJK(part.trim()));
		name = cjkPart ? cjkPart.trim() : parts[0].trim();
	}

	name = name
		.replace(/\s+-\s+\d+\b.*$/, "")
		.replace(/\s*\[\d+(?:v\d+)?(?:\s*[-~]\s*\d+)?].*$/, "")
		.replace(/\s+S\d+E\d+\b.*$/i, "")
		.replace(/(」)\s*The\s+.*$/i, "$1")
		.replace(/\s+\d{1,3}\s*$/, "")
		.trim();

	name = name
		.replace(/[[【][^\]】]*[\]】]/g, "")
		.replace(/[（(][^)）]*[)）]/g, "")
		.replace(/\b\d{3,4}[xX×]\d{3,4}\b/g, "")
		.replace(/\b(1080[pi]?|720[pi]?|480[pi]?|2160[pi]?|4K|UHD)\b/gi, "")
		.replace(/\b(HEVC|AVC|H\.?264|H\.?265|x264|x265|10bit|Hi10P|HDR)\b/gi, "")
		.replace(/\b(AAC|FLAC|DTS|AC3|MP3|OGG|OPUS|EAC3|TrueHD|Atmos)\b/gi, "")
		.replace(
			/\b(BluRay|BDRip|WEBRip|WEB-DL|DVDRip|HDTV|REMUX|BILIBILI|CR|B-Global|ABEMA|Baha|ViuTV)\b/gi,
			"",
		)
		.replace(/\b(MP4|MKV|AVI|RMVB|FLV|TS|WMV|MOV|WAV)\b/gi, "")
		.replace(/\b(CHS|CHT|JPN?|ENG?|GB|BIG5|YUE|PGS|SRT|OVA)\b/gi, "")
		.replace(
			/(简繁|繁日|简日|简体|繁体|繁體|簡體|双语|雙語|粤语|粵語|中文|日语|日英|配音)/g,
			"",
		)
		.replace(
			/(字幕组?|字幕組?|翻译|翻譯|招募|内嵌|外挂|内封|內嵌|內封|外封|无字幕|多國字幕)/g,
			"",
		)
		.replace(/★[^★]*★/g, "")
		.replace(/★/g, "")
		.replace(/\bv\d+\b/gi, "")
		.replace(/\bS\d+$/i, "")
		.replace(/\s+-\s*$/, "")
		.replace(/^\s*-\s+/, "")
		.replace(/\s+/g, " ")
		.trim();

	if (hasCJK(name)) {
		const cjkTruncated = name
			.replace(/\s+[A-Z][a-zA-Z]+(?:\s+[a-zA-Z]+)*\s*$/, "")
			.trim();
		if (cjkTruncated.length >= 2 && hasCJK(cjkTruncated)) name = cjkTruncated;
	}

	if (name.length < 2) {
		const fallback = fileName
			.replace(/\.[^.]+$/, "")
			.replace(/[\u3010\u3011【】[\]()（）{}「」『』★]/g, " ")
			.replace(/\b(1080[pi]?|720[pi]?)\b/gi, "")
			.replace(/[-_.]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		const words = fallback
			.split(" ")
			.filter((word) => word.length > 1 && !/^\d+$/.test(word));
		name = words.slice(0, 4).join(" ");
	}

	return cleanTitle(name);
}

export function extractSeasonNumber(fileName: string): number | null {
	const name = fileName.replace(/\.[^.]+$/, "");
	const patterns: [RegExp, ((match: RegExpMatchArray) => number)?][] = [
		[
			/第([一二三四五六七八九十])季/,
			(match) => "一二三四五六七八九十".indexOf(match[1]) + 1,
		],
		[/第(\d+)季/, (match) => Number.parseInt(match[1], 10)],
		[/\bS(\d+)\s*E\d+/i],
		[/\bS(\d+)\b(?!\d)/i],
		[/(\d+)(?:st|nd|rd|th)\s*Season/i],
	];
	for (const [pattern, transform] of patterns) {
		const match = name.match(pattern);
		if (!match) continue;
		const season = transform ? transform(match) : Number.parseInt(match[1], 10);
		if (season > 0 && season < 30) return season;
	}
	return null;
}

export function chineseToNumber(value: string): number {
	const digits: Record<string, number> = {
		一: 1,
		二: 2,
		三: 3,
		四: 4,
		五: 5,
		六: 6,
		七: 7,
		八: 8,
		九: 9,
		十: 10,
		零: 0,
	};
	if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
	let result = 0;
	let current = 0;
	for (const char of value) {
		const digit = digits[char];
		if (digit === undefined) continue;
		if (digit === 10) {
			result += (current || 1) * 10;
			current = 0;
		} else {
			current = digit;
		}
	}
	return result + current;
}

export function extractEpisodeNumber(fileName: string): number | null {
	const name = fileName.replace(/\.[^.]+$/, "");
	const chineseMatch = name.match(/第([一二三四五六七八九十百零]+)[话話集期]/);
	if (chineseMatch) {
		const episode = chineseToNumber(chineseMatch[1]);
		if (episode > 0 && episode < 999) return episode;
	}
	const patterns = [
		/第(\d+)[话話集期]/,
		/\bEP?\s*(\d+)\b/i,
		/\bS\d+E(\d+)\b/i,
		/★\s*(\d{1,3})\s*★/,
		/【(\d{1,3})】/,
		/\[\s*(\d{1,3})\s*]/,
		/\s+-\s+(\d{1,3})\s/,
		/\s+-\s+(\d{1,3})\s*$/,
		/[\s_.-]\s*(\d{2,3})\s*[\s_.\-[【(v]/,
		/[\s_.-]\s*(\d{2,3})\s*$/,
	];
	for (const pattern of patterns) {
		const match = name.match(pattern);
		if (!match) continue;
		const episode = Number.parseInt(match[1], 10);
		if (episode > 0 && episode < 999) return episode;
	}
	return null;
}

export function extractEpisodeNumberFromTitle(title: string): number | null {
	const chineseMatch = title.match(/第([一二三四五六七八九十百零]+)[话話集期]/);
	if (chineseMatch) return chineseToNumber(chineseMatch[1]);
	const numericMatch = title.match(/第\s*(\d+)\s*[话話集期]/);
	if (numericMatch) return Number.parseInt(numericMatch[1], 10);
	const episodeMatch = title.match(/\bEP?\s*(\d+)\b/i);
	if (episodeMatch) return Number.parseInt(episodeMatch[1], 10);
	const tailMatch = title.match(/(?:^|[\s\-—_#])\s*(\d{1,4})\s*$/);
	if (!tailMatch) return null;
	const episode = Number.parseInt(tailMatch[1], 10);
	return episode > 0 &&
		episode < 999 &&
		![1080, 720, 480, 2160, 1920].includes(episode)
		? episode
		: null;
}

export function extractKeyword(fileName: string): string {
	const title = extractTitle(fileName);
	const season = extractSeasonNumber(fileName);
	return season ? `${title} 第${season}季` : title;
}

export function findBestEpisode(
	fileName: string,
	animes: SearchAnime[],
): { episodeId: number; animeTitle: string; episodeTitle: string } | null {
	const episode = extractEpisodeNumber(fileName);
	if (episode === null) return null;
	for (const anime of animes) {
		for (const candidate of anime.episodes) {
			if (extractEpisodeNumberFromTitle(candidate.episodeTitle) === episode) {
				return {
					episodeId: candidate.episodeId,
					animeTitle: anime.animeTitle,
					episodeTitle: candidate.episodeTitle,
				};
			}
		}
	}
	return null;
}
