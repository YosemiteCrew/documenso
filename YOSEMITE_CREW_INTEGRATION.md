# Yosemite Crew PMS - Documenso Integration Documentation

## Complete Implementation Guide for AI Agents

This document contains all the code, file paths, and instructions needed to implement the external authentication integration between Yosemite Crew PMS and the Documenso fork, including UI restrictions for external users.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Already Implemented (Backend)](#already-implemented-backend)
4. [Files to Create/Modify for UI Restrictions](#files-to-createmodify-for-ui-restrictions)
5. [PMS Backend Integration Code](#pms-backend-integration-code)
6. [Environment Variables](#environment-variables)
7. [Testing](#testing)

---

## Overview

### Business Requirements

1. **Yosemite Crew PMS** has multiple vet businesses (organisations)
2. **Each organisation has employees** (some may belong to multiple orgs)
3. **Users are already authenticated in PMS** - no separate signup needed
4. **When navigating to ds.yosemitecrew.com**, auto-auth should happen
5. **Documents should be scoped** to the currently selected org only
6. **UI should be restricted** - only document features enabled, settings/profile/tokens hidden

### Integration Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          YOSEMITE CREW PMS                                   │
│                                                                              │
│  User is logged in, has selected "Happy Paws Vet" as current business        │
│  User clicks "View Documents"                                                │
│                                                                              │
│  1. PMS Backend calls:                                                       │
│     POST https://ds.yosemitecrew.com/api/auth/external/generate-token        │
│     {                                                                        │
│       "email": "john@happypaws.com",                                         │
│       "name": "John Doe",                                                    │
│       "businessId": "happy_paws_123",                                        │
│       "businessName": "Happy Paws Veterinary",                               │
│       "role": "ADMIN",                                                       │
│       "externalSecret": "your_shared_secret"                                 │
│     }                                                                        │
│                                                                              │
│  2. Response: { token: "abc123...", redirectUrl: "/auth/external?token=..." }│
│                                                                              │
│  3. PMS redirects user's browser to:                                         │
│     https://ds.yosemitecrew.com/auth/external?token=abc123...                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    DOCUMENSO (ds.yosemitecrew.com)                           │
│                                                                              │
│  4. /auth/external page:                                                     │
│     - Exchanges token for session (POST /api/auth/external/exchange-token)   │
│     - Creates user if doesn't exist                                          │
│     - Creates/joins organisation                                             │
│     - Sets session cookie                                                    │
│     - Redirects to /t/{teamUrl}/documents                                    │
│                                                                              │
│  5. User lands on team documents page                                        │
│     - Sees only their org's documents                                        │
│     - UI is restricted (no settings access)                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Architecture

### Multi-Tenancy Structure

```
User (identityProvider: EXTERNAL)
  └── OrganisationMember
        └── Organisation (url: "yc-{businessId}")
              └── Team (default team for business)
                    └── Documents (scoped to team)
```

### Key Concepts

- **businessId** from PMS becomes **Organisation URL** prefixed with `yc-`
- Each Organisation has a default **Team** where documents are stored
- **Session cookies** are set on the DS domain during token exchange
- **identityProvider: EXTERNAL** marks users who came from PMS

---

## Already Implemented (Backend)

The following files have already been created/modified:

### File 1: `/packages/auth/server/routes/external.ts`

**Full content:**

```typescript
import crypto from 'crypto';

import { IdentityProvider, OrganisationMemberRole, OrganisationType } from '@prisma/client';
import { Hono } from 'hono';

import { prisma } from '@documenso/prisma';

import { onAuthorize } from '../lib/utils/authorizer';
import type { HonoAuthContext } from '../types/context';

// In-memory store for auth tokens (in production, use Redis or database)
// Token format: { email, name, businessId, businessName, role, createdAt }
const authTokenStore = new Map<
  string,
  {
    email: string;
    name: string;
    businessId: string;
    businessName: string;
    role: 'ADMIN' | 'MANAGER' | 'MEMBER';
    createdAt: number;
  }
>();

// Clean up expired tokens (older than 5 minutes)
const TOKEN_EXPIRY_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of authTokenStore.entries()) {
    if (now - data.createdAt > TOKEN_EXPIRY_MS) {
      authTokenStore.delete(token);
    }
  }
}, 60 * 1000); // Clean every minute

/**
 * External authentication route for integrating with Yosemite Crew PMS.
 *
 * This route allows Yosemite Crew to authenticate users and provision
 * them into the document signing system with their business context.
 *
 * Security: Protected by a shared secret between systems.
 */
export const externalRoute = new Hono<HonoAuthContext>()
  /**
   * POST /api/auth/external/authorize
   *
   * Simple user authentication - creates session for a user.
   * Use this for basic login without business context.
   */
  .post('/authorize', async (c) => {
    const body = await c.req.json<{
      email: string;
      name: string;
      externalSecret: string;
    }>();

    const { email, name, externalSecret } = body;

    // Validate external secret
    const expectedSecret = process.env.EXTERNAL_AUTH_SECRET;

    if (!expectedSecret) {
      return c.json(
        {
          message: 'External authentication is not configured',
          statusCode: 500,
        },
        500,
      );
    }

    if (externalSecret !== expectedSecret) {
      return c.json(
        {
          message: 'Invalid external secret',
          statusCode: 401,
        },
        401,
      );
    }

    if (!email || !name) {
      return c.json(
        {
          message: 'Email and name are required',
          statusCode: 400,
        },
        400,
      );
    }

    // Find or create user by email
    let user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: email.toLowerCase(),
          name,
          emailVerified: new Date(),
          identityProvider: IdentityProvider.EXTERNAL,
        },
      });
    } else if (name && name !== user.name) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { name },
      });
    }

    // Create session
    await onAuthorize({ userId: user.id }, c);

    return c.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
  })

  /**
   * POST /api/auth/external/authorize-business
   *
   * Authenticates a user AND provisions them into a business (organisation).
   * This is the main endpoint for Yosemite Crew multi-business integration.
   */
  .post('/authorize-business', async (c) => {
    const body = await c.req.json<{
      email: string;
      name: string;
      businessId: string;
      businessName: string;
      role?: 'ADMIN' | 'MANAGER' | 'MEMBER';
      externalSecret: string;
    }>();

    const { email, name, businessId, businessName, role = 'MEMBER', externalSecret } = body;

    // Validate external secret
    const expectedSecret = process.env.EXTERNAL_AUTH_SECRET;

    if (!expectedSecret) {
      return c.json({ message: 'External authentication is not configured', statusCode: 500 }, 500);
    }

    if (externalSecret !== expectedSecret) {
      return c.json({ message: 'Invalid external secret', statusCode: 401 }, 401);
    }

    if (!email || !name || !businessId || !businessName) {
      return c.json(
        { message: 'email, name, businessId, and businessName are required', statusCode: 400 },
        400,
      );
    }

    // Map role string to OrganisationMemberRole
    const organisationRole = {
      ADMIN: OrganisationMemberRole.ADMIN,
      MANAGER: OrganisationMemberRole.MANAGER,
      MEMBER: OrganisationMemberRole.MEMBER,
    }[role];

    try {
      // 1. Find or create user
      let user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            email: email.toLowerCase(),
            name,
            emailVerified: new Date(),
            identityProvider: IdentityProvider.EXTERNAL,
          },
        });
      } else if (name && name !== user.name) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { name },
        });
      }

      // 2. Find or create organisation (business)
      const orgUrl = `yc-${businessId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

      let organisation = await prisma.organisation.findFirst({
        where: { url: orgUrl },
        include: {
          groups: true,
          teams: {
            take: 1,
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!organisation) {
        const { createOrganisation } = await import(
          '@documenso/lib/server-only/organisation/create-organisation'
        );
        const { createTeam } = await import('@documenso/lib/server-only/team/create-team');
        const { internalClaims, INTERNAL_CLAIM_ID } = await import(
          '@documenso/lib/types/subscription'
        );
        const { prefixedId } = await import('@documenso/lib/universal/id');

        const createdOrg = await createOrganisation({
          name: businessName,
          url: orgUrl,
          type: OrganisationType.ORGANISATION,
          userId: user.id,
          claim: internalClaims[INTERNAL_CLAIM_ID.FREE],
        });

        organisation = await prisma.organisation.findFirst({
          where: { id: createdOrg.id },
          include: {
            groups: true,
            teams: true,
          },
        });

        if (!organisation) {
          throw new Error('Failed to create organisation');
        }

        await createTeam({
          userId: user.id,
          teamName: businessName,
          teamUrl: prefixedId('team'),
          organisationId: organisation.id,
          inheritMembers: true,
        });

        organisation = await prisma.organisation.findFirst({
          where: { id: organisation.id },
          include: {
            groups: true,
            teams: {
              take: 1,
              orderBy: { createdAt: 'asc' },
            },
          },
        });
      } else {
        // Organisation exists - check if user is already a member
        const existingMember = await prisma.organisationMember.findFirst({
          where: {
            userId: user.id,
            organisationId: organisation.id,
          },
        });

        if (!existingMember) {
          const { generateDatabaseId } = await import('@documenso/lib/universal/id');

          const targetGroup = organisation.groups.find(
            (g) => g.organisationRole === organisationRole,
          );

          if (targetGroup) {
            await prisma.organisationMember.create({
              data: {
                id: generateDatabaseId('member'),
                userId: user.id,
                organisationId: organisation.id,
                organisationGroupMembers: {
                  create: {
                    id: generateDatabaseId('group_member'),
                    groupId: targetGroup.id,
                  },
                },
              },
            });
          }
        }
      }

      // 3. Create session
      await onAuthorize({ userId: user.id }, c);

      // 4. Get the team URL for redirection
      const team = organisation?.teams?.[0];

      return c.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
        organisation: {
          id: organisation?.id,
          name: organisation?.name,
          url: organisation?.url,
        },
        team: team
          ? {
              id: team.id,
              name: team.name,
              url: team.url,
            }
          : null,
        redirectUrl: team ? `/t/${team.url}` : `/o/${organisation?.url}`,
        documentsUrl: team ? `/t/${team.url}/documents` : null,
      });
    } catch (error) {
      console.error('External auth error:', error);
      return c.json(
        {
          message: error instanceof Error ? error.message : 'An error occurred',
          statusCode: 500,
        },
        500,
      );
    }
  })

  /**
   * POST /api/auth/external/verify
   *
   * Verify if a user exists and get their business memberships.
   */
  .post('/verify', async (c) => {
    const body = await c.req.json<{
      email: string;
      externalSecret: string;
    }>();

    const { email, externalSecret } = body;

    const expectedSecret = process.env.EXTERNAL_AUTH_SECRET;

    if (!expectedSecret || externalSecret !== expectedSecret) {
      return c.json({ message: 'Unauthorized', statusCode: 401 }, 401);
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerified: true,
        organisationMember: {
          select: {
            organisation: {
              select: {
                id: true,
                name: true,
                url: true,
                teams: {
                  select: {
                    id: true,
                    name: true,
                    url: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    return c.json({
      exists: !!user,
      user: user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
            organisations: user.organisationMember.map((m) => ({
              id: m.organisation.id,
              name: m.organisation.name,
              url: m.organisation.url,
              teams: m.organisation.teams,
            })),
          }
        : null,
    });
  })

  /**
   * POST /api/auth/external/remove-member
   *
   * Remove a user from a business (when employee leaves).
   */
  .post('/remove-member', async (c) => {
    const body = await c.req.json<{
      email: string;
      businessId: string;
      externalSecret: string;
    }>();

    const { email, businessId, externalSecret } = body;

    const expectedSecret = process.env.EXTERNAL_AUTH_SECRET;

    if (!expectedSecret || externalSecret !== expectedSecret) {
      return c.json({ message: 'Unauthorized', statusCode: 401 }, 401);
    }

    const orgUrl = `yc-${businessId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      return c.json({ success: true, message: 'User not found' });
    }

    const organisation = await prisma.organisation.findFirst({
      where: { url: orgUrl },
    });

    if (!organisation) {
      return c.json({ success: true, message: 'Organisation not found' });
    }

    // Remove membership
    await prisma.organisationMember.deleteMany({
      where: {
        userId: user.id,
        organisationId: organisation.id,
      },
    });

    return c.json({
      success: true,
      message: 'Member removed from organisation',
    });
  })

  /**
   * POST /api/auth/external/generate-token
   *
   * Generates a one-time auth token for browser redirect flow.
   * This is the recommended approach for PMS integration.
   */
  .post('/generate-token', async (c) => {
    const body = await c.req.json<{
      email: string;
      name: string;
      businessId: string;
      businessName: string;
      role?: 'ADMIN' | 'MANAGER' | 'MEMBER';
      externalSecret: string;
    }>();

    const { email, name, businessId, businessName, role = 'MEMBER', externalSecret } = body;

    const expectedSecret = process.env.EXTERNAL_AUTH_SECRET;

    if (!expectedSecret) {
      return c.json({ message: 'External authentication is not configured', statusCode: 500 }, 500);
    }

    if (externalSecret !== expectedSecret) {
      return c.json({ message: 'Invalid external secret', statusCode: 401 }, 401);
    }

    if (!email || !name || !businessId || !businessName) {
      return c.json(
        { message: 'email, name, businessId, and businessName are required', statusCode: 400 },
        400,
      );
    }

    const token = crypto.randomBytes(32).toString('hex');

    authTokenStore.set(token, {
      email,
      name,
      businessId,
      businessName,
      role,
      createdAt: Date.now(),
    });

    return c.json({
      success: true,
      token,
      redirectUrl: `/auth/external?token=${token}`,
    });
  })

  /**
   * POST /api/auth/external/exchange-token
   *
   * Exchanges a one-time token for a session.
   * Called by the frontend auth/external page.
   */
  .post('/exchange-token', async (c) => {
    const body = await c.req.json<{
      token: string;
    }>();

    const { token } = body;

    if (!token) {
      return c.json({ message: 'Token is required', statusCode: 400 }, 400);
    }

    const tokenData = authTokenStore.get(token);
    authTokenStore.delete(token);

    if (!tokenData) {
      return c.json({ message: 'Invalid or expired token', statusCode: 401 }, 401);
    }

    if (Date.now() - tokenData.createdAt > TOKEN_EXPIRY_MS) {
      return c.json({ message: 'Token has expired', statusCode: 401 }, 401);
    }

    const { email, name, businessId, businessName, role } = tokenData;

    const organisationRole = {
      ADMIN: OrganisationMemberRole.ADMIN,
      MANAGER: OrganisationMemberRole.MANAGER,
      MEMBER: OrganisationMemberRole.MEMBER,
    }[role];

    try {
      let user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            email: email.toLowerCase(),
            name,
            emailVerified: new Date(),
            identityProvider: IdentityProvider.EXTERNAL,
          },
        });
      } else if (name && name !== user.name) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { name },
        });
      }

      const orgUrl = `yc-${businessId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

      let organisation = await prisma.organisation.findFirst({
        where: { url: orgUrl },
        include: {
          groups: true,
          teams: {
            take: 1,
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!organisation) {
        const { createOrganisation } = await import(
          '@documenso/lib/server-only/organisation/create-organisation'
        );
        const { createTeam } = await import('@documenso/lib/server-only/team/create-team');
        const { internalClaims, INTERNAL_CLAIM_ID } = await import(
          '@documenso/lib/types/subscription'
        );
        const { prefixedId } = await import('@documenso/lib/universal/id');

        const createdOrg = await createOrganisation({
          name: businessName,
          url: orgUrl,
          type: OrganisationType.ORGANISATION,
          userId: user.id,
          claim: internalClaims[INTERNAL_CLAIM_ID.FREE],
        });

        organisation = await prisma.organisation.findFirst({
          where: { id: createdOrg.id },
          include: {
            groups: true,
            teams: true,
          },
        });

        if (!organisation) {
          throw new Error('Failed to create organisation');
        }

        await createTeam({
          userId: user.id,
          teamName: businessName,
          teamUrl: prefixedId('team'),
          organisationId: organisation.id,
          inheritMembers: true,
        });

        organisation = await prisma.organisation.findFirst({
          where: { id: organisation.id },
          include: {
            groups: true,
            teams: {
              take: 1,
              orderBy: { createdAt: 'asc' },
            },
          },
        });
      } else {
        const existingMember = await prisma.organisationMember.findFirst({
          where: {
            userId: user.id,
            organisationId: organisation.id,
          },
        });

        if (!existingMember) {
          const { generateDatabaseId } = await import('@documenso/lib/universal/id');

          const targetGroup = organisation.groups.find(
            (g) => g.organisationRole === organisationRole,
          );

          if (targetGroup) {
            await prisma.organisationMember.create({
              data: {
                id: generateDatabaseId('member'),
                userId: user.id,
                organisationId: organisation.id,
                organisationGroupMembers: {
                  create: {
                    id: generateDatabaseId('group_member'),
                    groupId: targetGroup.id,
                  },
                },
              },
            });
          }
        }
      }

      await onAuthorize({ userId: user.id }, c);

      const team = organisation?.teams?.[0];

      return c.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
        organisation: {
          id: organisation?.id,
          name: organisation?.name,
          url: organisation?.url,
        },
        team: team
          ? {
              id: team.id,
              name: team.name,
              url: team.url,
            }
          : null,
        redirectUrl: team ? `/t/${team.url}/documents` : `/o/${organisation?.url}`,
      });
    } catch (error) {
      console.error('External auth token exchange error:', error);
      return c.json(
        {
          message: error instanceof Error ? error.message : 'An error occurred',
          statusCode: 500,
        },
        500,
      );
    }
  });
```

### File 2: `/packages/auth/server/index.ts`

**Modified section (lines 21-43):**

```typescript
// Note: You must chain routes for Hono RPC client to work.
export const auth = new Hono<HonoAuthContext>()
  .use(async (c, next) => {
    c.set('requestMetadata', extractRequestMetadata(c.req.raw));

    const validOrigin = new URL(NEXT_PUBLIC_WEBAPP_URL()).origin;
    const headerOrigin = c.req.header('Origin');

    // Allow cross-origin requests for external auth routes (server-to-server calls from PMS)
    const isExternalRoute = c.req.path.includes('/external/');

    if (headerOrigin && headerOrigin !== validOrigin && !isExternalRoute) {
      return c.json(
        {
          message: 'Forbidden',
          statusCode: 403,
        },
        403,
      );
    }

    await next();
  })
```

### File 3: `/apps/remix/app/routes/auth.external.tsx`

**Full content:**

```typescript
import { useEffect, useState } from 'react';

import { redirect, useNavigate, useSearchParams } from 'react-router';

import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { Loader } from 'lucide-react';

import type { Route } from './+types/auth.external';

export function meta() {
  return [{ title: 'Authenticating... | Yosemite Crew' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { isAuthenticated } = await getOptionalSession(request);

  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  // If no token provided, redirect to signin
  if (!token) {
    throw redirect('/signin');
  }

  return {
    token,
    isAuthenticated,
  };
}

export default function ExternalAuth({ loaderData }: Route.ComponentProps) {
  const { token } = loaderData;
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const exchangeToken = async () => {
      try {
        const response = await fetch('/api/auth/external/exchange-token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token }),
          credentials: 'include', // Important: include cookies for session
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          setError(data.message || 'Authentication failed');
          setIsLoading(false);
          return;
        }

        // Redirect to the team documents page
        if (data.redirectUrl) {
          // Use window.location for full page reload to pick up new session
          window.location.href = data.redirectUrl;
        } else {
          window.location.href = '/';
        }
      } catch (err) {
        console.error('External auth error:', err);
        setError('An error occurred during authentication');
        setIsLoading(false);
      }
    };

    exchangeToken();
  }, [token]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-md rounded-lg border border-red-200 bg-red-50 p-6 text-center">
          <h1 className="text-xl font-semibold text-red-800">Authentication Failed</h1>
          <p className="mt-2 text-red-600">{error}</p>
          <a
            href="/signin"
            className="mt-4 inline-block rounded bg-red-600 px-4 py-2 text-white hover:bg-red-700"
          >
            Go to Sign In
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <Loader className="mx-auto h-8 w-8 animate-spin text-blue-600" />
        <h1 className="mt-4 text-xl font-semibold">Authenticating...</h1>
        <p className="mt-2 text-gray-600">Please wait while we sign you in.</p>
      </div>
    </div>
  );
}
```

### File 4: `/packages/prisma/schema.prisma`

**Modified enum (around line 28):**

```prisma
enum IdentityProvider {
  DOCUMENSO
  GOOGLE
  OIDC
  EXTERNAL
}
```

After modifying the schema, run:
```bash
npm run prisma:generate
```

---

## Files to Create/Modify for UI Restrictions

### Step 1: Expose identityProvider in Session

**File: `/packages/auth/server/lib/session/session.ts`**

**Current SessionUser type (line 16-26):**
```typescript
export type SessionUser = Pick<
  User,
  | 'id'
  | 'name'
  | 'email'
  | 'emailVerified'
  | 'avatarImageId'
  | 'twoFactorEnabled'
  | 'roles'
  | 'signature'
>;
```

**Change to:**
```typescript
export type SessionUser = Pick<
  User,
  | 'id'
  | 'name'
  | 'email'
  | 'emailVerified'
  | 'avatarImageId'
  | 'twoFactorEnabled'
  | 'roles'
  | 'signature'
  | 'identityProvider'  // ADD THIS LINE
>;
```

**Also update the Prisma select in validateSessionToken (around line 92-101):**

```typescript
select: {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  avatarImageId: true,
  twoFactorEnabled: true,
  roles: true,
  signature: true,
  identityProvider: true,  // ADD THIS LINE
},
```

### Step 2: Create External User Utility

**Create file: `/packages/lib/utils/is-external-user.ts`**

```typescript
import type { SessionUser } from '@documenso/auth/server/lib/session/session';

/**
 * Check if a user is from an external authentication provider (Yosemite Crew PMS).
 * External users have restricted UI access - they can only view/sign documents.
 */
export const isExternalUser = (user: SessionUser | null | undefined): boolean => {
  if (!user) return false;
  return user.identityProvider === 'EXTERNAL';
};
```

### Step 3: Modify Menu Switcher

**File: `/apps/remix/app/components/general/menu-switcher.tsx`**

**Add import at top:**
```typescript
import { isExternalUser } from '@documenso/lib/utils/is-external-user';
```

**Add check after getting user:**
```typescript
const { user } = useSession();
const isUserAdmin = isAdmin(user);
const isExternal = isExternalUser(user);  // ADD THIS LINE
```

**Wrap "Create Organisation" menu item (around line 69-77):**
```typescript
{!isExternal && (
  <DropdownMenuItem className="text-muted-foreground px-4 py-2" asChild>
    <Link
      to="/settings/organisations?action=add-organisation"
      className="flex items-center justify-between"
    >
      <Trans>Create Organisation</Trans>
      <Plus className="ml-2 h-4 w-4" />
    </Link>
  </DropdownMenuItem>
)}
{!isExternal && <DropdownMenuSeparator />}
```

**Wrap "User settings" menu item (around line 94-98):**
```typescript
{!isExternal && (
  <DropdownMenuItem className="text-muted-foreground px-4 py-2" asChild>
    <Link to="/settings/profile">
      <Trans>User settings</Trans>
    </Link>
  </DropdownMenuItem>
)}
```

**Full modified file:**
```typescript
import { useState } from 'react';

import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { ChevronsUpDown, Plus } from 'lucide-react';
import { Link } from 'react-router';

import { authClient } from '@documenso/auth/client';
import { useSession } from '@documenso/lib/client-only/providers/session';
import { formatAvatarUrl } from '@documenso/lib/utils/avatars';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { isExternalUser } from '@documenso/lib/utils/is-external-user';
import { extractInitials } from '@documenso/lib/utils/recipient-formatter';
import { LanguageSwitcherDialog } from '@documenso/ui/components/common/language-switcher-dialog';
import { cn } from '@documenso/ui/lib/utils';
import { AvatarWithText } from '@documenso/ui/primitives/avatar';
import { Button } from '@documenso/ui/primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@documenso/ui/primitives/dropdown-menu';

export const MenuSwitcher = () => {
  const { _ } = useLingui();

  const { user } = useSession();

  const [languageSwitcherOpen, setLanguageSwitcherOpen] = useState(false);

  const isUserAdmin = isAdmin(user);
  const isExternal = isExternalUser(user);

  const formatAvatarFallback = (name?: string) => {
    if (name !== undefined) {
      return name.slice(0, 1).toUpperCase();
    }

    return user.name ? extractInitials(user.name) : user.email.slice(0, 1).toUpperCase();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          data-testid="menu-switcher"
          variant="none"
          className="relative flex h-12 flex-row items-center px-0 py-2 ring-0 focus:outline-none focus-visible:border-0 focus-visible:ring-0 focus-visible:ring-transparent md:px-2"
        >
          <AvatarWithText
            avatarSrc={formatAvatarUrl(user.avatarImageId)}
            avatarFallback={formatAvatarFallback(user.name || user.email)}
            primaryText={user.name}
            secondaryText={_(msg`Personal Account`)}
            rightSideComponent={
              <ChevronsUpDown className="text-muted-foreground ml-auto h-4 w-4" />
            }
            textSectionClassName="hidden lg:flex"
          />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className={cn('z-[60] ml-6 w-full min-w-[12rem] md:ml-0')}
        align="end"
        forceMount
      >
        {!isExternal && (
          <>
            <DropdownMenuItem className="text-muted-foreground px-4 py-2" asChild>
              <Link
                to="/settings/organisations?action=add-organisation"
                className="flex items-center justify-between"
              >
                <Trans>Create Organisation</Trans>
                <Plus className="ml-2 h-4 w-4" />
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}

        {isUserAdmin && (
          <DropdownMenuItem className="text-muted-foreground px-4 py-2" asChild>
            <Link to="/admin">
              <Trans>Admin panel</Trans>
            </Link>
          </DropdownMenuItem>
        )}

        <DropdownMenuItem className="text-muted-foreground px-4 py-2" asChild>
          <Link to="/inbox">
            <Trans>Personal Inbox</Trans>
          </Link>
        </DropdownMenuItem>

        {!isExternal && (
          <DropdownMenuItem className="text-muted-foreground px-4 py-2" asChild>
            <Link to="/settings/profile">
              <Trans>User settings</Trans>
            </Link>
          </DropdownMenuItem>
        )}

        <DropdownMenuItem
          className="text-muted-foreground px-4 py-2"
          onClick={() => setLanguageSwitcherOpen(true)}
        >
          <Trans>Language</Trans>
        </DropdownMenuItem>

        <DropdownMenuItem
          className="text-destructive/90 hover:!text-destructive px-4 py-2"
          onSelect={async () => authClient.signOut()}
        >
          <Trans>Sign Out</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>

      <LanguageSwitcherDialog open={languageSwitcherOpen} setOpen={setLanguageSwitcherOpen} />
    </DropdownMenu>
  );
};
```

### Step 4: Modify Settings Desktop Navigation

**File: `/apps/remix/app/components/general/settings-nav-desktop.tsx`**

**Add import:**
```typescript
import { isExternalUser } from '@documenso/lib/utils/is-external-user';
```

**Add check after useSession:**
```typescript
const { organisations } = useSession();
const { user } = useSession();  // ADD THIS
const isExternal = isExternalUser(user);  // ADD THIS
```

**Wrap the entire isPersonalLayoutMode section and other restricted items:**

**Full modified file:**
```typescript
import type { HTMLAttributes } from 'react';

import { Trans } from '@lingui/react/macro';
import {
  BracesIcon,
  CreditCardIcon,
  Globe2Icon,
  Lock,
  Settings2Icon,
  User,
  Users,
  WebhookIcon,
} from 'lucide-react';
import { useLocation } from 'react-router';
import { Link } from 'react-router';

import { useSession } from '@documenso/lib/client-only/providers/session';
import { IS_BILLING_ENABLED } from '@documenso/lib/constants/app';
import { isExternalUser } from '@documenso/lib/utils/is-external-user';
import { canExecuteOrganisationAction, isPersonalLayout } from '@documenso/lib/utils/organisations';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';

export type SettingsDesktopNavProps = HTMLAttributes<HTMLDivElement>;

export const SettingsDesktopNav = ({ className, ...props }: SettingsDesktopNavProps) => {
  const { pathname } = useLocation();

  const { organisations, user } = useSession();

  const isPersonalLayoutMode = isPersonalLayout(organisations);
  const isExternal = isExternalUser(user);

  const hasManageableBillingOrgs = organisations.some((org) =>
    canExecuteOrganisationAction('MANAGE_BILLING', org.currentOrganisationRole),
  );

  // External users should not see settings navigation at all
  if (isExternal) {
    return null;
  }

  return (
    <div className={cn('flex flex-col gap-y-2', className)} {...props}>
      <Link to="/settings/profile">
        <Button
          variant="ghost"
          className={cn(
            'w-full justify-start',
            pathname?.startsWith('/settings/profile') && 'bg-secondary',
          )}
        >
          <User className="mr-2 h-5 w-5" />
          <Trans>Profile</Trans>
        </Button>
      </Link>

      {isPersonalLayoutMode && (
        <>
          <Link to="/settings/document">
            <Button variant="ghost" className={cn('w-full justify-start')}>
              <Settings2Icon className="mr-2 h-5 w-5" />
              <Trans>Preferences</Trans>
            </Button>
          </Link>

          <Link className="w-full pl-8" to="/settings/document">
            <Button
              variant="ghost"
              className={cn(
                'w-full justify-start',
                pathname?.startsWith('/settings/document') && 'bg-secondary',
              )}
            >
              <Trans>Document</Trans>
            </Button>
          </Link>

          <Link className="w-full pl-8" to="/settings/branding">
            <Button
              variant="ghost"
              className={cn(
                'w-full justify-start',
                pathname?.startsWith('/settings/branding') && 'bg-secondary',
              )}
            >
              <Trans>Branding</Trans>
            </Button>
          </Link>

          <Link className="w-full pl-8" to="/settings/email">
            <Button
              variant="ghost"
              className={cn(
                'w-full justify-start',
                pathname?.startsWith('/settings/email') && 'bg-secondary',
              )}
            >
              <Trans>Email</Trans>
            </Button>
          </Link>

          <Link to="/settings/public-profile">
            <Button
              variant="ghost"
              className={cn(
                'w-full justify-start',
                pathname?.startsWith('/settings/public-profile') && 'bg-secondary',
              )}
            >
              <Globe2Icon className="mr-2 h-5 w-5" />
              <Trans>Public Profile</Trans>
            </Button>
          </Link>

          <Link to="/settings/tokens">
            <Button
              variant="ghost"
              className={cn(
                'w-full justify-start',
                pathname?.startsWith('/settings/tokens') && 'bg-secondary',
              )}
            >
              <BracesIcon className="mr-2 h-5 w-5" />
              <Trans>API Tokens</Trans>
            </Button>
          </Link>

          <Link to="/settings/webhooks">
            <Button
              variant="ghost"
              className={cn(
                'w-full justify-start',
                pathname?.startsWith('/settings/webhooks') && 'bg-secondary',
              )}
            >
              <WebhookIcon className="mr-2 h-5 w-5" />
              <Trans>Webhooks</Trans>
            </Button>
          </Link>
        </>
      )}

      <Link to="/settings/organisations">
        <Button
          variant="ghost"
          className={cn(
            'w-full justify-start',
            pathname?.startsWith('/settings/organisations') && 'bg-secondary',
          )}
        >
          <Users className="mr-2 h-5 w-5" />
          <Trans>Organisations</Trans>
        </Button>
      </Link>

      {IS_BILLING_ENABLED() && hasManageableBillingOrgs && (
        <Link to={isPersonalLayoutMode ? '/settings/billing-personal' : `/settings/billing`}>
          <Button
            variant="ghost"
            className={cn(
              'w-full justify-start',
              pathname?.startsWith('/settings/billing') && 'bg-secondary',
            )}
          >
            <CreditCardIcon className="mr-2 h-5 w-5" />
            <Trans>Billing</Trans>
          </Button>
        </Link>
      )}

      <Link to="/settings/security">
        <Button
          variant="ghost"
          className={cn(
            'w-full justify-start',
            pathname?.startsWith('/settings/security') && 'bg-secondary',
          )}
        >
          <Lock className="mr-2 h-5 w-5" />
          <Trans>Security</Trans>
        </Button>
      </Link>
    </div>
  );
};
```

### Step 5: Modify Settings Mobile Navigation

**File: `/apps/remix/app/components/general/settings-nav-mobile.tsx`**

Apply the same changes as desktop navigation:
- Add import for `isExternalUser`
- Add `isExternal` check
- Return null for external users (or hide restricted items)

### Step 6: Add Route Guards for Settings Pages

**File: `/apps/remix/app/routes/_authenticated+/settings+/_layout.tsx`**

Add a loader check to redirect external users away from settings:

```typescript
import { redirect } from 'react-router';
import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';

export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  // Redirect external users away from settings
  if (user?.identityProvider === 'EXTERNAL') {
    throw redirect('/');
  }

  return {};
}
```

### Step 7: Restrict Team Settings (API Tokens, Webhooks)

**File: `/apps/remix/app/routes/_authenticated+/t.$teamUrl+/settings._layout.tsx`**

Add check to hide API Tokens and Webhooks for external users in the menu definition.

---

## PMS Backend Integration Code

### Node.js/TypeScript Example

**Create file in your PMS: `services/documenso.ts`**

```typescript
const DS_URL = process.env.DOCUMENSO_URL || 'https://ds.yosemitecrew.com';
const EXTERNAL_AUTH_SECRET = process.env.EXTERNAL_AUTH_SECRET;

interface GenerateTokenParams {
  email: string;
  name: string;
  businessId: string;
  businessName: string;
  role: 'ADMIN' | 'MANAGER' | 'MEMBER';
}

interface TokenResponse {
  success: boolean;
  token: string;
  redirectUrl: string;
}

/**
 * Generate a one-time authentication token for Documenso.
 * Returns the full redirect URL to send the user to.
 */
export async function generateDocumensoAuthToken(params: GenerateTokenParams): Promise<string> {
  if (!EXTERNAL_AUTH_SECRET) {
    throw new Error('EXTERNAL_AUTH_SECRET is not configured');
  }

  const response = await fetch(`${DS_URL}/api/auth/external/generate-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...params,
      externalSecret: EXTERNAL_AUTH_SECRET,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to generate Documenso auth token');
  }

  const data: TokenResponse = await response.json();

  // Return the full redirect URL
  return `${DS_URL}${data.redirectUrl}`;
}

/**
 * Remove a user from a Documenso organisation.
 * Call this when an employee leaves your organisation.
 */
export async function removeDocumensoMember(email: string, businessId: string): Promise<void> {
  if (!EXTERNAL_AUTH_SECRET) {
    throw new Error('EXTERNAL_AUTH_SECRET is not configured');
  }

  const response = await fetch(`${DS_URL}/api/auth/external/remove-member`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      businessId,
      externalSecret: EXTERNAL_AUTH_SECRET,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to remove member from Documenso');
  }
}

/**
 * Verify if a user exists in Documenso and get their organisations.
 */
export async function verifyDocumensoUser(email: string) {
  if (!EXTERNAL_AUTH_SECRET) {
    throw new Error('EXTERNAL_AUTH_SECRET is not configured');
  }

  const response = await fetch(`${DS_URL}/api/auth/external/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      externalSecret: EXTERNAL_AUTH_SECRET,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to verify user');
  }

  return response.json();
}
```

### Example API Route in PMS

**File: `api/documents/redirect.ts`**

```typescript
import { generateDocumensoAuthToken } from '../services/documenso';

export async function GET(request: Request) {
  // Get authenticated user from your auth system
  const user = await getAuthenticatedUser(request);

  if (!user) {
    return Response.redirect('/login');
  }

  // Get currently selected organisation from session/context
  const selectedOrg = await getCurrentOrganisation(request);

  if (!selectedOrg) {
    return new Response('No organisation selected', { status: 400 });
  }

  try {
    // Map your role to Documenso role
    const role = mapRoleToDocumenso(user.roleInOrg);

    const redirectUrl = await generateDocumensoAuthToken({
      email: user.email,
      name: user.name,
      businessId: selectedOrg.id,
      businessName: selectedOrg.name,
      role,
    });

    return Response.redirect(redirectUrl);
  } catch (error) {
    console.error('Failed to generate Documenso redirect:', error);
    return new Response('Failed to authenticate with document system', { status: 500 });
  }
}

function mapRoleToDocumenso(pmsRole: string): 'ADMIN' | 'MANAGER' | 'MEMBER' {
  switch (pmsRole) {
    case 'owner':
    case 'admin':
      return 'ADMIN';
    case 'manager':
      return 'MANAGER';
    default:
      return 'MEMBER';
  }
}
```

### React Component Example

**File: `components/DocumentsButton.tsx`**

```tsx
import { useState } from 'react';

export function DocumentsButton() {
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    setLoading(true);

    try {
      // Option 1: Direct redirect (backend handles everything)
      window.location.href = '/api/documents/redirect';

      // Option 2: Get URL first then redirect
      // const response = await fetch('/api/documents/get-url');
      // const { url } = await response.json();
      // window.location.href = url;
    } catch (error) {
      console.error('Failed to open documents:', error);
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="btn btn-primary"
    >
      {loading ? 'Opening...' : 'View Documents'}
    </button>
  );
}
```

---

## Environment Variables

### On Documenso (ds.yosemitecrew.com)

Add to `.env`:

```env
# External Authentication Secret
# Generate with: openssl rand -hex 32
EXTERNAL_AUTH_SECRET=your_secure_random_secret_here
```

### On PMS Backend

Add to `.env`:

```env
# Documenso Integration
DOCUMENSO_URL=https://ds.yosemitecrew.com
EXTERNAL_AUTH_SECRET=your_secure_random_secret_here  # Same as Documenso
```

---

## Testing

### 1. Test Token Generation

```bash
curl -X POST https://ds.yosemitecrew.com/api/auth/external/generate-token \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "name": "Test User",
    "businessId": "test_business_1",
    "businessName": "Test Business",
    "role": "ADMIN",
    "externalSecret": "your_secret"
  }'
```

Expected response:
```json
{
  "success": true,
  "token": "abc123...",
  "redirectUrl": "/auth/external?token=abc123..."
}
```

### 2. Test Full Flow

1. Open browser to: `https://ds.yosemitecrew.com/auth/external?token=abc123...`
2. Should automatically authenticate and redirect to `/t/{teamUrl}/documents`
3. User should only see documents for their organisation

### 3. Test UI Restrictions

After implementing UI restrictions:

1. Log in as external user (via token flow)
2. Verify:
   - No "Create Organisation" in menu
   - No "User settings" in menu
   - Settings pages redirect to home
   - No API Tokens or Webhooks access
   - Documents/Templates/Inbox are accessible

---

## Role Mapping

| PMS Role | Documenso Role | Permissions |
|----------|----------------|-------------|
| owner/admin | ADMIN | Full control: create, send, sign, manage settings |
| manager | MANAGER | Create, send, sign documents |
| staff/member | MEMBER | Sign documents, view assigned documents |

---

## Summary of All Files

### Already Created/Modified:

1. `/packages/auth/server/routes/external.ts` - External auth API endpoints
2. `/packages/auth/server/index.ts` - CORS handling for external routes
3. `/apps/remix/app/routes/auth.external.tsx` - Frontend token exchange page
4. `/packages/prisma/schema.prisma` - Added EXTERNAL to IdentityProvider enum

### Need to Create/Modify for UI Restrictions:

1. `/packages/lib/utils/is-external-user.ts` - Create new utility
2. `/packages/auth/server/lib/session/session.ts` - Add identityProvider to SessionUser
3. `/apps/remix/app/components/general/menu-switcher.tsx` - Hide restricted menu items
4. `/apps/remix/app/components/general/settings-nav-desktop.tsx` - Hide/restrict settings
5. `/apps/remix/app/components/general/settings-nav-mobile.tsx` - Hide/restrict settings
6. `/apps/remix/app/routes/_authenticated+/settings+/_layout.tsx` - Route guard

---

## Troubleshooting

### Token Invalid or Expired
- Tokens expire after 5 minutes
- Tokens are one-time use only
- Check that secrets match between PMS and DS

### User Not Redirecting
- Ensure `credentials: 'include'` in fetch calls
- Check browser console for errors
- Verify session cookie is being set

### Organisation Not Created
- Check Prisma logs for errors
- Verify user has valid email
- Check that businessId doesn't contain invalid characters

### UI Restrictions Not Working
- Run `npm run prisma:generate` after schema changes
- Restart the development server
- Check that identityProvider is in SessionUser type
