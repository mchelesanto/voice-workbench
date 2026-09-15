import { application } from "@/server/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request) {
  return application()(request);
}
export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
  handle as OPTIONS,
  handle as HEAD,
};
