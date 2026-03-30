#!/usr/bin/env node

/**
 * Migrate WordPress XML export to Astro markdown posts.
 * Usage: node scripts/migrate-wp-xml.js path/to/export.xml
 */

import fs from 'fs/promises';
import path from 'path';
import TurndownService from 'turndown';

const INPUT_FILE = process.argv[2];
const OUTPUT_DIR = './src/content/posts';

if (!INPUT_FILE) {
  console.error('Usage: node scripts/migrate-wp-xml.js <wordpress-export.xml>');
  process.exit(1);
}

// Simple XML text extraction helpers (no dependency needed for WXR)
function extractCDATA(text) {
  const match = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return match ? match[1] : text.replace(/<[^>]+>/g, '').trim();
}

function extractTag(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`, 's');
  const match = xml.match(regex);
  if (!match) return '';
  return extractCDATA(match[1]);
}

// Set up Turndown for HTML-to-Markdown conversion
const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

// Remove Flash embeds (object/embed tags)
turndown.addRule('removeFlash', {
  filter: ['object', 'embed', 'form'],
  replacement: () => '',
});

// Convert iframes to links
turndown.addRule('iframe', {
  filter: 'iframe',
  replacement: (content, node) => {
    const src = node.getAttribute('src') || '';
    if (src.includes('youtube')) return `[Watch on YouTube](${src})\n`;
    return src ? `[Embedded content](${src})\n` : '';
  },
});

/**
 * Convert HTML to Markdown using Turndown
 */
function htmlToMarkdown(html) {
  if (!html) return '';

  let cleaned = html;

  // Remove WordPress <!--more--> tags
  cleaned = cleaned.replace(/<!--more-->/g, '');

  // Remove <object>/<embed> tags (old Flash, Turndown can't see these well)
  cleaned = cleaned.replace(/<object[\s\S]*?<\/object>/gi, '');
  cleaned = cleaned.replace(/<embed[^>]*\/?>/gi, '');

  // Remove <form> tags
  cleaned = cleaned.replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '');

  // Convert with Turndown
  let md = turndown.turndown(cleaned);

  // WordPress shortcodes
  md = md.replace(/\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/gi, '$1');
  md = md.replace(/\[\/?[a-z_]+[^\]]*\]/gi, '');

  // Fix broken image markdown: !(url) or !(url "title") -> ![](url)
  md = md.replace(/!\(([^)]+)\)/g, (match, inner) => {
    // Already valid markdown image ![...](...) won't match since we look for !( not ![
    // Strip title attribute from URL if present
    const url = inner.replace(/\s+"[^"]*"$/, '').trim();
    return `![](${url})`;
  });

  // Clean up whitespace
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.trim();

  return md;
}

/**
 * Escape frontmatter title (handle quotes)
 */
function escapeTitle(title) {
  return `"${title.replace(/"/g, '\\"')}"`;
}

/**
 * Parse all items from WXR XML
 */
function parseItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];

    const postType = extractTag(itemXml, 'wp:post_type');
    const status = extractTag(itemXml, 'wp:status');

    if (postType !== 'post' || status !== 'publish') continue;

    const title = extractTag(itemXml, 'title') || 'Untitled';
    const slug = extractTag(itemXml, 'wp:post_name');
    const dateStr = extractTag(itemXml, 'wp:post_date');
    const content = extractTag(itemXml, 'content:encoded');
    const creator = extractTag(itemXml, 'dc:creator');

    const date = dateStr ? dateStr.split(' ')[0] : new Date().toISOString().split('T')[0];

    items.push({ title, slug, date, content, creator });
  }

  return items;
}

const authorMap = {
  'thestrategydaddy': 'Ankesh Kothari',
  'keeseem': 'Michael Keesee',
  '': 'Ankesh Kothari',
};

async function migrate() {
  console.log(`Reading ${INPUT_FILE}...`);
  const xml = await fs.readFile(INPUT_FILE, 'utf-8');

  const posts = parseItems(xml);
  console.log(`Found ${posts.length} published posts`);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let success = 0;
  let failed = 0;

  for (const post of posts) {
    try {
      const markdown = htmlToMarkdown(post.content);

      const frontmatter = [
        '---',
        `title: ${escapeTitle(post.title)}`,
        `date: "${post.date}"`,
        '---',
      ].join('\n');

      const output = `${frontmatter}\n\n${markdown}\n`;
      const filename = `${post.slug}.md`;
      await fs.writeFile(path.join(OUTPUT_DIR, filename), output, 'utf-8');

      success++;
      console.log(`  OK: ${filename}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL: ${post.slug} - ${err.message}`);
    }
  }

  console.log(`\nDone: ${success} migrated, ${failed} failed`);
}

migrate().catch(err => {
  console.error(`Migration failed: ${err.message}`);
  process.exit(1);
});
