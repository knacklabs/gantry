import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  FIND_CUSTOMER_BY_EMAIL,
  FIND_CUSTOMER_BY_PHONE,
} from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import type { ShopifyCustomer } from '../shopify/types.js';
import { normalizeEmail, normalizePhone } from '../privacy/guard.js';
import { resolveEffectiveIdentity } from '../privacy/effective-identity.js';
import { customerVerifiedPhoneNotFoundError } from '../privacy/customer-safe-response.js';
import { jsonContent, toolErrorContent } from './shared.js';

const inputSchema = {
  phone: z
    .string()
    .min(4)
    .optional()
    .describe(
      'Customer phone (e.g. +919876543210 or 9876543210). In customer conversations, this must match the phone number being used to message. At least one of phone/email is required only for operator lookups without channel identity.',
    ),
  email: z
    .string()
    .email()
    .optional()
    .describe(
      'Customer email. In customer conversations, this must belong to the same customer as the phone number being used to message. At least one of phone/email is required only for operator lookups without channel identity.',
    ),
};

interface CustomerEdgeResponse {
  customers: { edges: Array<{ node: ShopifyCustomer }> };
}

interface CustomerSummary {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

function projectCustomer(
  node: ShopifyCustomer,
  fallbackPhone?: string,
  fallbackEmail?: string,
): CustomerSummary {
  return {
    id: node.id,
    firstName: node.firstName ?? undefined,
    lastName: node.lastName ?? undefined,
    email: node.email ?? fallbackEmail,
    phone: node.phone ?? fallbackPhone,
  };
}

async function lookupByPhone(
  client: ShopifyClient,
  normalizedPhone: string,
): Promise<ShopifyCustomer | undefined> {
  const data = await client.graphql<CustomerEdgeResponse>(
    FIND_CUSTOMER_BY_PHONE,
    { query: `phone:${normalizedPhone}` },
  );
  const edges = data.customers?.edges ?? [];
  const match = edges.find(
    (edge) => normalizePhone(edge.node.phone) === normalizedPhone,
  );
  return match?.node ?? edges[0]?.node;
}

async function lookupByEmail(
  client: ShopifyClient,
  normalizedEmail: string,
): Promise<ShopifyCustomer | undefined> {
  const data = await client.graphql<CustomerEdgeResponse>(
    FIND_CUSTOMER_BY_EMAIL,
    { query: `email:${normalizedEmail}` },
  );
  const edges = data.customers?.edges ?? [];
  const match = edges.find(
    (edge) => normalizeEmail(edge.node.email) === normalizedEmail,
  );
  return match?.node ?? edges[0]?.node;
}

export function registerLookupCustomer(
  server: McpServer,
  client: ShopifyClient,
  options: { requireVerifiedIdentity?: boolean } = {},
): void {
  server.tool(
    'lookup_customer',
    "Resolve the current customer's Shopify customer record by phone or email. In customer conversations, omit phone/email unless the user explicitly provided them; supplied values must belong to the same customer as the phone number being used to message. Operator lookups without channel identity require at least one of phone/email. Prefers phone match, falls back to email. Returns found=false on no match.",
    inputSchema,
    async (args) => {
      try {
        const identity = resolveEffectiveIdentity({
          callerPhone: args.phone,
          callerEmail: args.email,
          requireVerifiedIdentity: options.requireVerifiedIdentity ?? false,
        });

        // Phone path first when available — preferred identity axis.
        if (identity.phone) {
          const node = await lookupByPhone(client, identity.phone);
          if (node) {
            return jsonContent({
              found: true,
              customer: projectCustomer(node, identity.phone, identity.email),
              matchedVia: 'phone',
              identitySource: identity.source,
            });
          }
        }

        // Fall back to email if we have it.
        if (identity.email) {
          const node = await lookupByEmail(client, identity.email);
          if (node) {
            return jsonContent({
              found: true,
              customer: projectCustomer(node, identity.phone, identity.email),
              matchedVia: 'email',
              identitySource: identity.source,
            });
          }
        }

        if (identity.requireVerifiedIdentity) {
          throw customerVerifiedPhoneNotFoundError(
            'CALLER_NOT_FOUND',
            'verified phone did not match any Shopify customer',
          );
        }
        return jsonContent({ found: false });
      } catch (err) {
        return toolErrorContent(err);
      }
    },
  );
}
