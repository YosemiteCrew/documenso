import { Trans } from '@lingui/react/macro';
import { IdentityProvider } from '@prisma/client';
import { Outlet, redirect } from 'react-router';

import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';

import { SettingsDesktopNav } from '~/components/general/settings-nav-desktop';
import { SettingsMobileNav } from '~/components/general/settings-nav-mobile';
import { appMetaTags } from '~/utils/meta';

import type { Route } from './+types/_layout';

export function meta() {
  return appMetaTags('Settings');
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  if (user?.identityProvider === IdentityProvider.EXTERNAL) {
    throw redirect('/');
  }

  return {};
}

export default function SettingsLayout() {
  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 md:px-8">
      <h1 className="text-4xl font-semibold">
        <Trans>Settings</Trans>
      </h1>

      <div className="mt-4 grid grid-cols-12 gap-x-8 md:mt-8">
        <SettingsDesktopNav className="hidden md:col-span-3 md:flex" />
        <SettingsMobileNav className="col-span-12 mb-8 md:hidden" />

        <div className="col-span-12 md:col-span-9">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
