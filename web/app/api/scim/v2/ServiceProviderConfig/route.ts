// SCIM 2.0 ServiceProviderConfig. Static, advertises what we support so
// Okta/Azure AD know which endpoints to call during a provisioning sync.
import { NextRequest } from "next/server";
import { scimJson, scimBaseUrl } from "@/lib/scimGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const base = scimBaseUrl(req);
  return scimJson({
    schemas: [
      "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
    ],
    documentationUri: `${base}/docs`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description:
          "Authentication scheme using the OAuth Bearer Token Standard",
        specUri: "https://www.rfc-editor.org/info/rfc6750",
        primary: true,
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: `${base}/scim/v2/ServiceProviderConfig`,
    },
  });
}
