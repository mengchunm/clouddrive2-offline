import { Converter } from "opencc-js/t2cn";

type SearchableTask = {
  name: string;
  url?: string;
  infoHash?: string;
  searchText?: string;
};

const toSimplifiedChinese = Converter({ from: "t", to: "cn" });

export function normalizeTaskSearchText(value: string): string {
  return toSimplifiedChinese(value.normalize("NFKC")).toLocaleLowerCase("zh-CN");
}

export function getTaskSearchKeywords(query: string): string[] {
  return normalizeTaskSearchText(query).trim().split(/\s+/u).filter(Boolean);
}

export function createTaskSearchText(task: SearchableTask): string {
  return normalizeTaskSearchText([task.name, task.url, task.infoHash].filter(Boolean).join(" "));
}

export function matchesTaskSearch(task: SearchableTask, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const searchableText = task.searchText ?? createTaskSearchText(task);
  return keywords.every((keyword) => searchableText.includes(keyword));
}
