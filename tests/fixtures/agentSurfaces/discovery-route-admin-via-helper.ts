// A discovery-zone route whose helper builds the service-role client (fence A
// sees no direct import).
import { adminItems } from './helpers/adminItems';

export async function GET() {
  return Response.json(await adminItems());
}
