import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';

export async function GET(context) {
	const posts = await getCollection('blog');
	return rss({
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
		// 채널 링크도 base(/ai-blog)를 포함해야 한다
		site: new URL(import.meta.env.BASE_URL, context.site),
		items: posts.map((post) => ({
			...post.data,
			link: `${import.meta.env.BASE_URL.replace(/\/$/, '')}/blog/${post.id}/`,
		})),
	});
}
