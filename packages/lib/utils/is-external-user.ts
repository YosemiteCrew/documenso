import type { User } from '@prisma/client';
import { IdentityProvider } from '@prisma/client';

type ExternalUserCheck = Pick<User, 'identityProvider'> | null | undefined;

export const isExternalUser = (user: ExternalUserCheck) => {
  if (!user) {
    return false;
  }

  return user.identityProvider === IdentityProvider.EXTERNAL;
};
