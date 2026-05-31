// SCIM 2.0 Schemas. Minimal advertisement of the core User schema. Some
// IdPs (Azure AD) fetch this before the first push to validate fields.
import { NextRequest } from "next/server";
import { scimJson } from "@/lib/scimGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USER_SCHEMA = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
  id: "urn:ietf:params:scim:schemas:core:2.0:User",
  name: "User",
  description: "User Account",
  attributes: [
    {
      name: "userName",
      type: "string",
      multiValued: false,
      required: true,
      caseExact: false,
      mutability: "readWrite",
      returned: "default",
      uniqueness: "server",
    },
    {
      name: "name",
      type: "complex",
      multiValued: false,
      required: false,
      mutability: "readWrite",
      returned: "default",
      uniqueness: "none",
      subAttributes: [
        { name: "givenName", type: "string", mutability: "readWrite" },
        { name: "familyName", type: "string", mutability: "readWrite" },
      ],
    },
    {
      name: "active",
      type: "boolean",
      multiValued: false,
      required: false,
      mutability: "readWrite",
      returned: "default",
    },
    {
      name: "emails",
      type: "complex",
      multiValued: true,
      required: false,
      mutability: "readWrite",
      returned: "default",
      subAttributes: [
        { name: "value", type: "string", mutability: "readWrite" },
        { name: "primary", type: "boolean", mutability: "readWrite" },
        { name: "type", type: "string", mutability: "readWrite" },
      ],
    },
    {
      name: "externalId",
      type: "string",
      multiValued: false,
      required: false,
      mutability: "readWrite",
      returned: "default",
      uniqueness: "none",
    },
  ],
};

export async function GET(_req: NextRequest) {
  return scimJson({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: 1,
    Resources: [USER_SCHEMA],
  });
}
