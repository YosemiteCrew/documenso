import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus, FieldType, RecipientRole } from '@prisma/client';
import { CheckCircle2, Clock8, DownloadIcon, Loader2 } from 'lucide-react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';

import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { getDocumentAndSenderByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { isRecipientAuthorized } from '@documenso/lib/server-only/document/is-recipient-authorized';
import { getFieldsForToken } from '@documenso/lib/server-only/field/get-fields-for-token';
import { getRecipientByToken } from '@documenso/lib/server-only/recipient/get-recipient-by-token';
import { getRecipientSignatures } from '@documenso/lib/server-only/recipient/get-recipient-signatures';
import { getUserByEmail } from '@documenso/lib/server-only/user/get-user-by-email';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { env } from '@documenso/lib/utils/env';
import { trpc } from '@documenso/trpc/react';
import { SigningCard3D } from '@documenso/ui/components/signing-card';
import { cn } from '@documenso/ui/lib/utils';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';

import { EnvelopeDownloadDialog } from '~/components/dialogs/envelope-download-dialog';
import { ClaimAccount } from '~/components/general/claim-account';
import { DocumentSigningAuthPageView } from '~/components/general/document-signing/document-signing-auth-page';

import type { Route } from './+types/complete';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  const { token } = params;

  if (!token) {
    throw new Response('Not Found', { status: 404 });
  }

  const document = await getDocumentAndSenderByToken({
    token,
    requireAccessAuth: false,
  }).catch(() => null);

  if (!document || !document.documentData) {
    throw new Response('Not Found', { status: 404 });
  }

  const [fields, recipient] = await Promise.all([
    getFieldsForToken({ token }),
    getRecipientByToken({ token }).catch(() => null),
  ]);

  if (!recipient) {
    throw new Response('Not Found', { status: 404 });
  }

  const isDocumentAccessValid = await isRecipientAuthorized({
    type: 'ACCESS',
    documentAuthOptions: document.authOptions,
    recipient,
    userId: user?.id,
  });

  if (!isDocumentAccessValid) {
    return {
      isDocumentAccessValid: false,
      recipientEmail: recipient.email,
    } as const;
  }

  const signatures = await getRecipientSignatures({ recipientId: recipient.id });
  const isExistingUser = await getUserByEmail({ email: recipient.email })
    .then((u) => !!u)
    .catch(() => false);

  const recipientName =
    recipient.name ||
    fields.find((field) => field.type === FieldType.NAME)?.customText ||
    recipient.email;

  const canSignUp = !isExistingUser && env('NEXT_PUBLIC_DISABLE_SIGNUP') !== 'true';

  const canRedirectToFolder =
    user && document.userId === user.id && document.folderId && document.team?.url;

  const returnToHomePath = canRedirectToFolder
    ? `/t/${document.team.url}/documents/f/${document.folderId}`
    : '/';

  return {
    isDocumentAccessValid: true,
    canSignUp,
    recipientName,
    recipientEmail: recipient.email,
    signatures,
    document,
    recipient,
    returnToHomePath,
  };
}

export default function CompletedSigningPage({ loaderData }: Route.ComponentProps) {
  const { _ } = useLingui();

  const { sessionData } = useOptionalSession();
  const user = sessionData?.user;

  const {
    isDocumentAccessValid,
    canSignUp,
    recipientName,
    signatures,
    document,
    recipient,
    recipientEmail,
    returnToHomePath,
  } = loaderData;

  // Poll signing status every few seconds
  const { data: signingStatusData } = trpc.envelope.signingStatus.useQuery(
    {
      token: recipient?.token || '',
    },
    {
      refetchInterval: 3000,
      initialData: match(document?.status)
        .with(DocumentStatus.COMPLETED, () => ({ status: 'COMPLETED' }) as const)
        .with(DocumentStatus.REJECTED, () => ({ status: 'REJECTED' }) as const)
        .with(DocumentStatus.PENDING, () => ({ status: 'PENDING' }) as const)
        .otherwise(() => ({ status: 'PENDING' }) as const),
    },
  );

  // Use signing status from query if available, otherwise fall back to document status
  const signingStatus = signingStatusData?.status ?? 'PENDING';

  if (!isDocumentAccessValid) {
    return <DocumentSigningAuthPageView email={recipientEmail} />;
  }

  return (
    <div
      className={cn(
        'yc-sign-complete -mx-4 flex flex-col items-center overflow-hidden px-4 pt-8 md:-mx-8 md:px-8 lg:pt-10 xl:pt-12',
        { 'pt-0 lg:pt-0 xl:pt-0': canSignUp },
      )}
    >
      <div
        className={cn('relative mt-2 flex w-full flex-col items-center justify-center', {
          'mt-0 flex-col divide-y overflow-hidden pt-6 md:pt-16 lg:flex-row lg:divide-x lg:divide-y-0 lg:pt-20 xl:pt-24':
            canSignUp,
        })}
      >
        <div
          className={cn('flex flex-col items-center', {
            'mb-8 p-4 md:mb-0 md:p-12': canSignUp,
          })}
        >
          <Badge
            variant="neutral"
            size="default"
            className="mb-6 rounded-2xl border border-[#595958] bg-transparent"
          >
            <span className="block max-w-[10rem] truncate font-medium hover:underline md:max-w-[20rem]">
              {document.title}
            </span>
          </Badge>

          {/* Card with recipient */}
          <div className="relative isolate">
            <div
              className="pointer-events-none absolute left-1/2 top-1/2 z-0 h-[360px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-200/55 blur-3xl"
              aria-hidden
            />
            <div
              className="pointer-events-none absolute left-1/2 top-1/2 z-0 h-[320px] w-[520px] -translate-x-1/2 -translate-y-1/2 opacity-80"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 1px 1px, rgba(37, 99, 235, 0.35) 1px, transparent 0)',
                backgroundSize: '14px 14px',
                mask: 'radial-gradient(rgba(255, 255, 255, 1) 0%, transparent 72%)',
                WebkitMask: 'radial-gradient(rgba(255, 255, 255, 1) 0%, transparent 72%)',
              }}
              aria-hidden
            />
            <SigningCard3D
              className="relative z-10"
              name={recipientName}
              signature={signatures.at(0)}
            />
          </div>

          <h2 className="mt-6 max-w-[35ch] text-center text-2xl font-semibold leading-normal md:text-3xl lg:text-4xl">
            {recipient.role === RecipientRole.SIGNER && <Trans>Document Signed</Trans>}
            {recipient.role === RecipientRole.VIEWER && <Trans>Document Viewed</Trans>}
            {recipient.role === RecipientRole.APPROVER && <Trans>Document Approved</Trans>}
          </h2>

          {match({ status: signingStatus, deletedAt: document.deletedAt })
            .with({ status: 'COMPLETED' }, () => (
              <div className="mt-4 flex items-center text-center text-documenso-700">
                <CheckCircle2 className="mr-2 h-5 w-5" />
                <span className="text-sm">
                  <Trans>Everyone has signed</Trans>
                </span>
              </div>
            ))
            .with({ status: 'PROCESSING' }, () => (
              <div className="mt-4 flex items-center text-center text-orange-600">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                <span className="text-sm">
                  <Trans>Processing document</Trans>
                </span>
              </div>
            ))
            .with({ deletedAt: null }, () => (
              <div className="mt-4 flex items-center text-center text-blue-600">
                <Clock8 className="mr-2 h-5 w-5" />
                <span className="text-sm">
                  <Trans>Waiting for others to sign</Trans>
                </span>
              </div>
            ))
            .otherwise(() => (
              <div className="flex items-center text-center text-red-600">
                <Clock8 className="mr-2 h-5 w-5" />
                <span className="text-sm">
                  <Trans>Document no longer available to sign</Trans>
                </span>
              </div>
            ))}

          {match({ status: signingStatus, deletedAt: document.deletedAt })
            .with({ status: 'COMPLETED' }, () => (
              <p className="mt-2.5 max-w-[60ch] text-center text-sm font-medium text-muted-foreground/60 md:text-base">
                <Trans>
                  Everyone has signed! You will receive an email copy of the signed document.
                </Trans>
              </p>
            ))
            .with({ status: 'PROCESSING' }, () => (
              <p className="mt-2.5 max-w-[60ch] text-center text-sm font-medium text-muted-foreground/60 md:text-base">
                <Trans>
                  All recipients have signed. The document is being processed and you will receive
                  an email copy shortly.
                </Trans>
              </p>
            ))
            .with({ deletedAt: null }, () => (
              <p className="mt-2.5 max-w-[60ch] text-center text-sm font-medium text-muted-foreground/60 md:text-base">
                <Trans>
                  You will receive an email copy of the signed document once everyone has signed.
                </Trans>
              </p>
            ))
            .otherwise(() => (
              <p className="mt-2.5 max-w-[60ch] text-center text-sm font-medium text-muted-foreground/60 md:text-base">
                <Trans>
                  This document has been cancelled by the owner and is no longer available for
                  others to sign.
                </Trans>
              </p>
            ))}

          <div className="yc-sign-actions mt-8 flex w-full max-w-xs flex-col items-stretch gap-4 md:w-auto md:max-w-none md:flex-row md:items-center">
            {isDocumentCompleted(document) && (
              <EnvelopeDownloadDialog
                envelopeId={document.envelopeId}
                envelopeStatus={document.status}
                envelopeItems={document.envelopeItems}
                token={recipient?.token}
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    className="yc-btn-secondary flex-1 md:flex-initial"
                  >
                    <DownloadIcon className="mr-2 h-5 w-5" />
                    <Trans>Download</Trans>
                  </Button>
                }
              />
            )}

            {user && (
              <Button asChild className="yc-btn-primary">
                <Link to={returnToHomePath}>
                  <Trans>Go Back Home</Trans>
                </Link>
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-col items-center">
          {canSignUp && (
            <div className="flex max-w-xl flex-col items-center justify-center p-4 md:p-12">
              <h2 className="mt-8 text-center text-xl font-semibold md:mt-0">
                <Trans>Need to sign documents?</Trans>
              </h2>

              <p className="mt-4 max-w-[55ch] text-center leading-normal text-muted-foreground/60">
                <Trans>
                  Create your account and start using state-of-the-art document signing.
                </Trans>
              </p>

              <ClaimAccount defaultName={recipientName} defaultEmail={recipient.email} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
