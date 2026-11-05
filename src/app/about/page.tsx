import { redirect } from 'next/navigation';

/** Marketing about page retired with the landing. Keep the path from 404ing. */
export default function AboutPage() {
  redirect('/projects');
}
