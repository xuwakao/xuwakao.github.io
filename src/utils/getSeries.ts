import type { CollectionEntry } from "astro:content";
import { BLOG_PATH } from "@/content.config";

export interface Series {
  name: string;
  slug: string;
  count: number;
}

export function getSeriesFromPost(post: CollectionEntry<"blog">): string {
  const segments = post.filePath
    ?.replace(BLOG_PATH, "")
    .split("/")
    .filter(p => p !== "" && !p.startsWith("_"));
  if (segments && segments.length > 1) {
    return segments[0];
  }
  return "";
}

export function getUniqueSeries(posts: CollectionEntry<"blog">[]): Series[] {
  const seriesMap = new Map<string, number>();
  for (const post of posts) {
    const series = getSeriesFromPost(post);
    if (series) {
      seriesMap.set(series, (seriesMap.get(series) || 0) + 1);
    }
  }
  return Array.from(seriesMap.entries())
    .map(([name, count]) => ({ name, slug: name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getPostsBySeries(
  posts: CollectionEntry<"blog">[],
  series: string
): CollectionEntry<"blog">[] {
  return posts.filter(post => getSeriesFromPost(post) === series);
}

const SERIES_LABELS: Record<string, string> = {
  android: "Android",
  atl: "ATL 深度解析",
  waydroid: "Waydroid 源码分析",
};

export function getSeriesLabel(slug: string): string {
  return SERIES_LABELS[slug] || slug;
}
