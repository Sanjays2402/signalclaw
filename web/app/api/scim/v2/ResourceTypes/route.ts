// SCIM 2.0 ResourceTypes. Static. We expose only User; Groups are not
// modelled because access is governed by the audited admin console.
import { NextRequest } from "next/server";
import { scimJson, scimBaseUrl } from "@/lib/scimGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const base = scimBaseUrl(req);
  return scimJson({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: 1,
    Resources: [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "User",
        name: "User",
        endpoint: "/Users",
        description: "User Account",
        schema: "urn:ietf:params:scim:schemas:core:2.0:User",
        meta: {
          location: `${base}/scim/v2/ResourceTypes/User`,
          resourceType: "ResourceType",
        },
      },
    ],
  });
}
