import { z } from 'zod';
import type { TimeClient } from '../client/time-client.js';
import type { Post, PostList } from '../types/time-api.js';

export const messageTools = [
  {
    name: 'send_message',
    description:
      'Send a message to a channel or reply in a thread. Optionally attach local files via file_paths (absolute paths).',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'Channel ID to send message to',
        },
        message: {
          type: 'string',
          description: 'Message text (supports Markdown)',
        },
        root_id: {
          type: 'string',
          description: 'Optional: Post ID to reply in a thread',
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: absolute local file paths to upload and attach (max 10)',
        },
      },
      required: ['channel_id', 'message'],
    },
    handler: async (client: TimeClient, args: unknown) => {
      const schema = z.object({
        channel_id: z.string(),
        message: z.string(),
        root_id: z.string().optional(),
        file_paths: z.array(z.string()).max(10).optional(),
      });

      const params = schema.parse(args);
      const fileIds: string[] = [];
      for (const filePath of params.file_paths ?? []) {
        fileIds.push(await client.uploadFile(params.channel_id, filePath));
      }
      const post = fileIds.length
        ? await client.createPost(params.channel_id, params.message, params.root_id, fileIds)
        : await client.createPost(params.channel_id, params.message, params.root_id);

      return {
        content: [
          {
            type: 'text',
            text: `Message sent successfully!\n\nPost ID: ${post.id}\n${fileIds.length ? `Files attached: ${fileIds.length}\n` : ''}Created at: ${new Date(post.create_at).toISOString()}`,
          },
        ],
      };
    },
  },

  {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message as the current user',
    inputSchema: {
      type: 'object',
      properties: {
        post_id: { type: 'string', description: 'Post ID of the message to react to' },
        emoji_name: {
          type: 'string',
          description: 'Emoji name without colons, e.g. thumbsup, eyes, white_check_mark',
        },
      },
      required: ['post_id', 'emoji_name'],
    },
    handler: async (client: TimeClient, args: unknown) => {
      const schema = z.object({ post_id: z.string(), emoji_name: z.string().min(1) });
      const params = schema.parse(args);
      await client.addReaction(params.post_id, params.emoji_name);
      return {
        content: [
          {
            type: 'text',
            text: `Reaction :${params.emoji_name.replace(/^:|:$/g, '')}: added to post ${params.post_id}`,
          },
        ],
      };
    },
  },

  {
    name: 'get_channel_messages',
    description: 'Get messages from a channel with pagination',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'Channel ID',
        },
        page: {
          type: 'number',
          description: 'Page number (default: 0)',
        },
        per_page: {
          type: 'number',
          description: 'Messages per page (default: 60, max: 200)',
        },
      },
      required: ['channel_id'],
    },
    handler: async (client: TimeClient, args: unknown) => {
      const schema = z.object({
        channel_id: z.string(),
        page: z.number().int().min(0).default(0),
        per_page: z.number().int().min(1).max(200).default(60),
      });

      const params = schema.parse(args);
      const postList = await client.getPostsForChannel(
        params.channel_id,
        params.page,
        params.per_page
      );

      return {
        content: [
          {
            type: 'text',
            text: formatPostList(postList, await resolveReactionUsers(client, Object.values(postList.posts))),
          },
        ],
      };
    },
  },

  {
    name: 'get_thread_messages',
    description: 'Get all messages in a thread',
    inputSchema: {
      type: 'object',
      properties: {
        post_id: {
          type: 'string',
          description: 'Post ID (root post of the thread)',
        },
      },
      required: ['post_id'],
    },
    handler: async (client: TimeClient, args: unknown) => {
      const schema = z.object({
        post_id: z.string(),
      });

      const params = schema.parse(args);
      const postList = await client.getPostThread(params.post_id);

      return {
        content: [
          {
            type: 'text',
            text: formatPostList(postList, await resolveReactionUsers(client, Object.values(postList.posts))),
          },
        ],
      };
    },
  },

  {
    name: 'search_messages',
    description: 'Search messages in a team',
    inputSchema: {
      type: 'object',
      properties: {
        team_id: {
          type: 'string',
          description: 'Team ID to search in',
        },
        terms: {
          type: 'string',
          description: 'Search terms',
        },
      },
      required: ['team_id', 'terms'],
    },
    handler: async (client: TimeClient, args: unknown) => {
      const schema = z.object({
        team_id: z.string(),
        terms: z.string(),
      });

      const params = schema.parse(args);
      const result = await client.searchPosts(params.team_id, params.terms);

      return {
        content: [
          {
            type: 'text',
            text: formatSearchResult(result, await resolveReactionUsers(client, Object.values(result.posts))),
          },
        ],
      };
    },
  },
];

type UserNames = Record<string, string>;

export async function resolveReactionUsers(client: TimeClient, posts: Post[]): Promise<UserNames> {
  const ids = new Set<string>();
  for (const post of posts) {
    for (const r of post?.metadata?.reactions ?? []) ids.add(r.user_id);
  }
  const names: UserNames = {};
  if (ids.size === 0) return names;
  try {
    for (const u of await client.getUsersByIds([...ids])) names[u.id] = u.username || u.id;
  } catch {
    // fall back to raw user ids
  }
  return names;
}

function formatReactions(post: Post, names: UserNames): string {
  const reactions: { user_id: string; emoji_name: string }[] = post.metadata?.reactions ?? [];
  if (reactions.length === 0) return '';
  const byEmoji: Record<string, string[]> = {};
  for (const r of reactions) {
    (byEmoji[r.emoji_name] ??= []).push(names[r.user_id] ?? r.user_id);
  }
  const parts = Object.entries(byEmoji).map(
    ([emoji, users]) => `:${emoji}: x${users.length} (${users.join(', ')})`
  );
  return `\nReactions: ${parts.join('; ')}`;
}

export function formatPostList(postList: PostList, names: UserNames = {}): string {
  const seen = new Set<string>();
  const posts = postList.order
    .map((id) => postList.posts[id])
    .filter((post): post is Post => {
      if (!post || seen.has(post.id)) return false;
      seen.add(post.id);
      return true;
    })
    .reverse();

  if (posts.length === 0) {
    return 'No messages found.';
  }

  const lines = posts.map((post) => {
    const date = new Date(post.create_at).toLocaleString();
    const isReply = post.root_id ? ' (reply)' : '';
    return `[${date}]${isReply} id:${post.id}\n${post.message}${formatReactions(post, names)}\n---`;
  });

  return lines.join('\n\n');
}

export function formatSearchResult(
  result: { order: string[]; posts: Record<string, Post> },
  names: UserNames = {}
): string {
  const posts = result.order
    .map((id) => result.posts[id])
    .filter(Boolean);

  if (posts.length === 0) {
    return 'No messages found matching your search.';
  }

  const lines = posts.map((post) => {
    const date = new Date(post.create_at).toLocaleString();
    return `[${date}] Channel: ${post.channel_id} id:${post.id}\n${post.message}${formatReactions(post, names)}\n---`;
  });

  return `Found ${posts.length} message(s):\n\n${lines.join('\n\n')}`;
}
