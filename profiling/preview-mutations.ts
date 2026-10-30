import { z } from "zod";
import application from "../src/index";
import type { Bindings } from "../src/configuration";
import { previewUploadSchema, MAXIMUM_PREVIEW_UPLOAD_BYTES } from "../shared/preview-image";
import { storePreviewImage } from "../src/preview-image";
import { updateSiteSettingsSchema } from "../shared/contracts";
import { updateSiteSettings } from "../src/settings";

const imageSchema = z.object({ slug: z.string().regex(/^sample-[0-9]+$/), upload: previewUploadSchema }).strict();

// this isolated diagnostic measures persistence, not Access JWT validation. it is never the application entry point.
export default {
  async fetch(request, environment, context): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__profile/")) return application.fetch(request, environment, context);
    if (request.method !== "POST" || !environment.PROFILE_TOKEN || request.headers.get("Authorization") !== `Bearer ${environment.PROFILE_TOKEN}`) {
      return new Response(null, { status: 401 });
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAXIMUM_PREVIEW_UPLOAD_BYTES) return new Response(null, { status: 413 });
    const payload: unknown = JSON.parse(text);
    if (path === "/__profile/image") {
      const { slug, upload } = imageSchema.parse(payload);
      await storePreviewImage(environment.DB, slug, upload);
      return new Response(null, { status: 204 });
    }
    if (path === "/__profile/settings") {
      const settings = updateSiteSettingsSchema.parse(payload);
      await updateSiteSettings(environment.DB, { subject: "staging", email: "synthetic@example.com" }, settings);
      return Response.json(settings.displayName);
    }
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Bindings & { readonly PROFILE_TOKEN?: string }>;
