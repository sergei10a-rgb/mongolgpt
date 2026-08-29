import { and, eq, isNotNull, or } from "drizzle-orm";
import { Database } from "./drizzle";
import { Identifier } from "./identifier";
import { AccountTable } from "./schema/account.sql";
import { AuthTable } from "./schema/auth.sql";

type OAuthProvider = "github" | "google";

export type OAuthAccountProvisioningInput = {
  provider: OAuthProvider;
  subject: string;
  email: string;
};

export type OAuthAccountProvisioningResult = {
  accountID: string;
  newAccount: boolean;
};

type OAuthAccountProvisioningDependencies = {
  transaction?: typeof Database.transaction;
};

export class OAuthIdentityConflictError extends Error {
  constructor() {
    super("OAuth provider and email identities belong to different accounts");
  }
}

class OAuthAccountProvisioningRaceError extends Error {
  constructor() {
    super("oauth_account_provisioning_race");
  }
}

export async function provisionOAuthAccountIdentity(
  input: OAuthAccountProvisioningInput,
  dependencies: OAuthAccountProvisioningDependencies = {},
): Promise<OAuthAccountProvisioningResult> {
  const transaction = dependencies.transaction ?? Database.transaction;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await transaction((tx) =>
        provisionOAuthAccountIdentityWithDb(tx, input),
      );
    } catch (error) {
      if (error instanceof OAuthAccountProvisioningRaceError) continue;
      throw error;
    }
  }

  throw new Error(
    "OAuth аккаунт үүсгэх үед давхцсан хүсэлт дууссангүй. Дахин оролдоно уу.",
  );
}

async function provisionOAuthAccountIdentityWithDb(
  tx: Database.TxOrDb,
  input: OAuthAccountProvisioningInput,
): Promise<OAuthAccountProvisioningResult> {
  const matches = await tx
    .select({
      provider: AuthTable.provider,
      accountID: AuthTable.accountID,
      timeDeleted: AuthTable.timeDeleted,
    })
    .from(AuthTable)
    .where(
      or(
        and(
          eq(AuthTable.provider, input.provider),
          eq(AuthTable.subject, input.subject),
        ),
        and(
          eq(AuthTable.provider, "email"),
          eq(AuthTable.subject, input.email),
        ),
      ),
    );
  const accountID = resolveActiveAccountIdentity(matches, input.provider);

  if (accountID) {
    await ensureOAuthIdentityLinked(tx, {
      accountID,
      provider: input.provider,
      subject: input.subject,
    });
    await ensureOAuthIdentityLinked(tx, {
      accountID,
      provider: "email",
      subject: input.email,
    });
    return { accountID, newAccount: false };
  }

  const newAccountID = Identifier.create("account");
  await claimNewOAuthIdentity(tx, {
    accountID: newAccountID,
    provider: input.provider,
    subject: input.subject,
  });
  await claimNewOAuthIdentity(tx, {
    accountID: newAccountID,
    provider: "email",
    subject: input.email,
  });
  await tx.insert(AccountTable).values({ id: newAccountID });

  return { accountID: newAccountID, newAccount: true };
}

function resolveActiveAccountIdentity(
  matches: Array<{
    provider: string;
    accountID: string;
    timeDeleted: unknown;
  }>,
  provider: OAuthProvider,
) {
  const active = matches.filter((match) => match.timeDeleted === null);
  const providerAccountID = active.find(
    (match) => match.provider === provider,
  )?.accountID;
  const emailAccountID = active.find(
    (match) => match.provider === "email",
  )?.accountID;

  if (
    providerAccountID &&
    emailAccountID &&
    providerAccountID !== emailAccountID
  ) {
    throw new OAuthIdentityConflictError();
  }

  return providerAccountID ?? emailAccountID;
}

async function ensureOAuthIdentityLinked(
  tx: Database.TxOrDb,
  input: {
    accountID: string;
    provider: OAuthProvider | "email";
    subject: string;
  },
) {
  const existing = await findIdentity(tx, input);

  if (!existing) {
    const inserted = await tx
      .insert(AuthTable)
      .values({
        id: Identifier.create("auth"),
        accountID: input.accountID,
        provider: input.provider,
        subject: input.subject,
      })
      .onConflictDoNothing({ target: [AuthTable.provider, AuthTable.subject] })
      .returning({ id: AuthTable.id });
    if (inserted.length === 0) throw new OAuthAccountProvisioningRaceError();
    return;
  }

  if (existing.timeDeleted === null && existing.accountID !== input.accountID) {
    throw new OAuthAccountProvisioningRaceError();
  }

  const updated = await tx
    .update(AuthTable)
    .set({
      accountID: input.accountID,
      timeDeleted: null,
    })
    .where(
      and(
        eq(AuthTable.id, existing.id),
        existing.timeDeleted === null
          ? eq(AuthTable.accountID, input.accountID)
          : isNotNull(AuthTable.timeDeleted),
      ),
    )
    .returning({ id: AuthTable.id });
  if (updated.length === 0) throw new OAuthAccountProvisioningRaceError();
}

async function claimNewOAuthIdentity(
  tx: Database.TxOrDb,
  input: {
    accountID: string;
    provider: OAuthProvider | "email";
    subject: string;
  },
) {
  const existing = await findIdentity(tx, input);

  if (!existing) {
    const inserted = await tx
      .insert(AuthTable)
      .values({
        id: Identifier.create("auth"),
        accountID: input.accountID,
        provider: input.provider,
        subject: input.subject,
      })
      .onConflictDoNothing({ target: [AuthTable.provider, AuthTable.subject] })
      .returning({ id: AuthTable.id });
    if (inserted.length === 0) throw new OAuthAccountProvisioningRaceError();
    return;
  }

  if (existing.timeDeleted === null)
    throw new OAuthAccountProvisioningRaceError();

  const updated = await tx
    .update(AuthTable)
    .set({
      accountID: input.accountID,
      timeDeleted: null,
    })
    .where(and(eq(AuthTable.id, existing.id), isNotNull(AuthTable.timeDeleted)))
    .returning({ id: AuthTable.id });
  if (updated.length === 0) throw new OAuthAccountProvisioningRaceError();
}

async function findIdentity(
  tx: Database.TxOrDb,
  input: {
    provider: OAuthProvider | "email";
    subject: string;
  },
) {
  return tx
    .select({
      id: AuthTable.id,
      accountID: AuthTable.accountID,
      timeDeleted: AuthTable.timeDeleted,
    })
    .from(AuthTable)
    .where(
      and(
        eq(AuthTable.provider, input.provider),
        eq(AuthTable.subject, input.subject),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
}
