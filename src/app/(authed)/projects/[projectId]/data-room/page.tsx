import { DataRoomSwitch } from '@/components/dataroom/DataRoomSwitch';

/**
 * `/projects/[projectId]/data-room` — the deal's documents.
 *
 * Behind the platform_onboarding flag this is the LIVE room-split document
 * store over /api/v1/deals/{dealId}/documents (the server walls rows per
 * viewer). Flag off, it stays the fixture explorer over the external manifest,
 * exactly the pre-onboarding surface. The switch lives in DataRoomSwitch so
 * this page stays a server component.
 */
export default function DataRoomPage() {
  return <DataRoomSwitch />;
}
