import { IdentityProvider, OrganisationMemberRole, OrganisationType } from '@prisma/client';
import crypto from 'crypto';
import { Hono } from 'hono';

import { hashString } from '@documenso/lib/server-only/auth/hash';
import { prisma } from '@documenso/prisma';

import { onAuthorize } from '../lib/utils/authorizer';
import type { HonoAuthContext } from '../types/context';

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

const TOKEN_EXPIRY_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of authTokenStore.entries()) {
    if (now - data.createdAt > TOKEN_EXPIRY_MS) {
      authTokenStore.delete(token);
    }
  }
}, 60 * 1000);

const PMS_WEBHOOK_URL = process.env.DOCUMENSO_PMS_WEBHOOK_URL ?? '';
const PMS_WEBHOOK_SECRET = process.env.DOCUMENSO_PMS_WEBHOOK_SECRET ?? '';

const sendApiTokenToPms = async ({
  businessId,
  apiToken,
}: {
  businessId: string;
  apiToken: string;
}) => {
  if (!PMS_WEBHOOK_URL || !PMS_WEBHOOK_SECRET) {
    console.warn('PMS webhook not configured, skipping API key sync');
    return;
  }

  const payload = JSON.stringify({
    businessId,
    apiToken,
  });

  const signature = crypto.createHmac('sha256', PMS_WEBHOOK_SECRET).update(payload).digest('hex');

  try {
    const webhookUrl = `${PMS_WEBHOOK_URL}/v1/documenso/pms/store-api-key/${businessId}`;
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-documenso-signature': signature,
      },
      body: payload,
    });

    if (!response.ok) {
      console.warn('PMS webhook failed', {
        status: response.status,
        businessId,
      });
      return;
    }

    console.info('PMS webhook delivered', { businessId });
  } catch (error) {
    console.error('Failed to send Documenso API token to PMS:', error);
  }
};

const createExternalTeamApiToken = async ({
  teamId,
  organisationId,
  userId,
}: {
  teamId: number;
  organisationId: string;
  userId: number;
}) => {
  const tokenName = `yc-external-${organisationId}`;

  const existingToken = await prisma.apiToken.findFirst({
    where: {
      teamId,
      name: tokenName,
    },
  });

  if (existingToken) {
    return null;
  }

  const rawToken = `api_${crypto.randomBytes(12).toString('hex')}`;

  await prisma.apiToken.create({
    data: {
      name: tokenName,
      token: hashString(rawToken),
      userId,
      teamId,
    },
  });

  return rawToken;
};

export const externalRoute = new Hono<HonoAuthContext>()
  .post('/authorize', async (c) => {
    const body = await c.req.json<{
      email: string;
      name: string;
      externalSecret: string;
    }>();

    const { email, name, externalSecret } = body;

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

      const apiToken = team
        ? await createExternalTeamApiToken({
            teamId: team.id,
            organisationId: organisation?.id ?? orgUrl,
            userId: user.id,
          })
        : null;

      if (apiToken) {
        await sendApiTokenToPms({
          businessId,
          apiToken,
        });
      }

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
        ...(team
          ? {
              redirectUrl: `/t/${team.url}`,
              documentsUrl: `/t/${team.url}/documents`,
            }
          : {
              redirectUrl: `/o/${organisation?.url}`,
              documentsUrl: null,
            }),
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

      const apiToken = team
        ? await createExternalTeamApiToken({
            teamId: team.id,
            organisationId: organisation?.id ?? orgUrl,
            userId: user.id,
          })
        : null;

      if (apiToken) {
        await sendApiTokenToPms({
          businessId,
          apiToken,
        });
      }

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
        ...(team
          ? {
              redirectUrl: `/t/${team.url}`,
              documentsUrl: `/t/${team.url}/documents`,
            }
          : {
              redirectUrl: `/o/${organisation?.url}`,
              documentsUrl: null,
            }),
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
  });
