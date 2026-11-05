import { notFound } from 'next/navigation';

/**
 * Ask (/projects/[projectId]/chat) is not in the MVP. The canned composer
 * stays in the tree but this route must not be reachable — not from nav,
 * not from a typed URL.
 */
export default function ChatPage() {
  notFound();
}
