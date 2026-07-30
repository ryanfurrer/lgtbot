import { Client, Events, GuildMember, ThreadChannel } from 'discord.js';
import { logger } from './logger';

const INTRODUCE_YOURSELF_CHANNEL_ID = '1157749239598821516';
const VERIFIED_ROLE_ID = '1531700897623572700';
const UNVERIFIED_ROLE_ID = '1532179332460576913';
const ROLE_LOG_CHANNEL_ID = '1532182270209949758';
const TRACKED_ROLES = [
  { id: VERIFIED_ROLE_ID, name: 'verified' },
  { id: UNVERIFIED_ROLE_ID, name: 'unverified' },
];

async function sendRoleLog(client: Client, content: string): Promise<void> {
  const channel = await client.channels.fetch(ROLE_LOG_CHANNEL_ID);

  if (!channel?.isTextBased() || !('send' in channel)) {
    throw new Error('Role log channel is not a text-based channel');
  }

  await channel.send({
    content,
    allowedMentions: { parse: [] },
  });
}

async function reportRoleChangeFailure({
  member,
  action,
  roleId,
  error,
}: {
  member: GuildMember;
  action: 'add' | 'remove';
  roleId: string;
  error: unknown;
}): Promise<void> {
  const actionDescription =
    action === 'add' ? `add <@&${roleId}> to` : `remove <@&${roleId}> from`;
  const errorMessage =
    error instanceof Error ? error.message : 'Unknown Discord API error';

  try {
    await sendRoleLog(
      member.guild.client,
      `❌ Failed to ${actionDescription} <@${member.id}>: ${errorMessage.slice(0, 500)}`
    );
  } catch (logError) {
    logger.error(logError, 'Error sending role assignment failure log');
  }
}

async function changeMemberRole({
  member,
  action,
  roleId,
  reason,
}: {
  member: GuildMember;
  action: 'add' | 'remove';
  roleId: string;
  reason: string;
}): Promise<void> {
  try {
    await member.roles[action](roleId, reason);
  } catch (error) {
    await reportRoleChangeFailure({ member, action, roleId, error });
    throw error;
  }
}

export async function assignUnverifiedRole(
  member: GuildMember
): Promise<boolean> {
  if (
    member.user.bot ||
    member.roles.cache.has(UNVERIFIED_ROLE_ID) ||
    member.roles.cache.has(VERIFIED_ROLE_ID)
  ) {
    return false;
  }

  await changeMemberRole({
    member,
    action: 'add',
    roleId: UNVERIFIED_ROLE_ID,
    reason: 'Joined the server',
  });

  logger.info(
    { memberId: member.id },
    'Assigned unverified role to new member'
  );

  return true;
}

export async function verifyIntroductionThreadCreator(
  thread: ThreadChannel
): Promise<boolean> {
  if (thread.parentId !== INTRODUCE_YOURSELF_CHANNEL_ID || !thread.ownerId) {
    return false;
  }

  const member = await thread.guild.members.fetch(thread.ownerId);

  if (member.user.bot) {
    return false;
  }

  const needsVerifiedRole = !member.roles.cache.has(VERIFIED_ROLE_ID);
  const hasUnverifiedRole = member.roles.cache.has(UNVERIFIED_ROLE_ID);

  if (!needsVerifiedRole && !hasUnverifiedRole) {
    return false;
  }

  if (needsVerifiedRole) {
    await changeMemberRole({
      member,
      action: 'add',
      roleId: VERIFIED_ROLE_ID,
      reason: 'Created a thread in the introduce-yourself channel',
    });
  }

  if (hasUnverifiedRole) {
    await changeMemberRole({
      member,
      action: 'remove',
      roleId: UNVERIFIED_ROLE_ID,
      reason: 'Completed introduction by creating a thread',
    });
  }

  logger.info(
    {
      memberId: member.id,
      threadId: thread.id,
    },
    'Updated roles for introduction thread creator'
  );

  return true;
}

export function registerVerificationListeners(client: Client) {
  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    try {
      for (const role of TRACKED_ROLES) {
        const hadRole = oldMember.roles.cache.has(role.id);
        const hasRole = newMember.roles.cache.has(role.id);

        if (hadRole === hasRole) continue;

        const change = hasRole ? 'gained' : 'lost';
        await sendRoleLog(
          client,
          `<@${newMember.id}> ${change} the <@&${role.id}> role (${role.name}).`
        );
      }
    } catch (error) {
      logger.error(error, 'Error sending role change log');
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      await assignUnverifiedRole(member);
    } catch (error) {
      logger.error(error, 'Error assigning unverified role to new member');
    }
  });

  client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
    if (!newlyCreated) return;

    try {
      await verifyIntroductionThreadCreator(thread);
    } catch (error) {
      logger.error(error, 'Error verifying introduction thread creator');
    }
  });

  logger.info('Verification listeners registered');
}
