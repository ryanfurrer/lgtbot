import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Client, GuildMember, ThreadChannel } from 'discord.js';
import {
  assignUnverifiedRole,
  registerVerificationListeners,
  verifyIntroductionThreadCreator,
} from '../verification';
import {
  mockDiscordChannel,
  mockDiscordClient,
  resetMockDiscordClient,
} from './mockDiscordClient';

const INTRODUCE_YOURSELF_CHANNEL_ID = '1157749239598821516';
const VERIFIED_ROLE_ID = '1531700897623572700';
const UNVERIFIED_ROLE_ID = '1532179332460576913';
const ROLE_LOG_CHANNEL_ID = '1532182270209949758';

function createMockMember({
  isBot = false,
  hasVerifiedRole = false,
  hasUnverifiedRole = false,
  addRoleError,
  id = 'member123',
}: {
  isBot?: boolean;
  hasVerifiedRole?: boolean;
  hasUnverifiedRole?: boolean;
  addRoleError?: Error;
  id?: string;
} = {}) {
  const roleOperations: string[] = [];
  const addRole = mock((roleId: string) => {
    roleOperations.push(`add:${roleId}`);
    if (addRoleError) return Promise.reject(addRoleError);
    return Promise.resolve();
  });
  const removeRole = mock((roleId: string) => {
    roleOperations.push(`remove:${roleId}`);
    return Promise.resolve();
  });
  const member = {
    id,
    user: { bot: isBot },
    guild: {
      client: mockDiscordClient,
    },
    roles: {
      cache: {
        has: (roleId: string) =>
          (roleId === VERIFIED_ROLE_ID && hasVerifiedRole) ||
          (roleId === UNVERIFIED_ROLE_ID && hasUnverifiedRole),
      },
      add: addRole,
      remove: removeRole,
    },
  } as unknown as GuildMember;

  return { addRole, member, removeRole, roleOperations };
}

function createMockThread({
  parentId = INTRODUCE_YOURSELF_CHANNEL_ID,
  ownerId = 'member123',
  isBot = false,
  hasVerifiedRole = false,
  hasUnverifiedRole = true,
}: {
  parentId?: string;
  ownerId?: string | null;
  isBot?: boolean;
  hasVerifiedRole?: boolean;
  hasUnverifiedRole?: boolean;
} = {}) {
  const { addRole, member, removeRole, roleOperations } = createMockMember({
    isBot,
    hasVerifiedRole,
    hasUnverifiedRole,
  });
  const fetchMember = mock(() => Promise.resolve(member));
  const thread = {
    id: 'thread123',
    parentId,
    ownerId,
    guild: {
      members: {
        fetch: fetchMember,
      },
    },
  } as unknown as ThreadChannel;

  return {
    addRole,
    fetchMember,
    removeRole,
    roleOperations,
    thread,
  };
}

describe('introduction verification', () => {
  beforeEach(() => {
    resetMockDiscordClient();
  });

  test('assigns the unverified role when a member joins', async () => {
    const { addRole, member } = createMockMember();

    const assigned = await assignUnverifiedRole(member);

    expect(assigned).toBe(true);
    expect(addRole).toHaveBeenCalledWith(
      UNVERIFIED_ROLE_ID,
      'Joined the server'
    );
  });

  test('does not assign the unverified role to bots', async () => {
    const { addRole, member } = createMockMember({ isBot: true });

    const assigned = await assignUnverifiedRole(member);

    expect(assigned).toBe(false);
    expect(addRole).not.toHaveBeenCalled();
  });

  test('does not assign unverified to an already verified member', async () => {
    const { addRole, member } = createMockMember({ hasVerifiedRole: true });

    const assigned = await assignUnverifiedRole(member);

    expect(assigned).toBe(false);
    expect(addRole).not.toHaveBeenCalled();
  });

  test('reports a failed unverified role assignment', async () => {
    const { member } = createMockMember({
      addRoleError: new Error('Missing Permissions'),
    });

    await expect(assignUnverifiedRole(member)).rejects.toThrow(
      'Missing Permissions'
    );

    expect(mockDiscordClient.channels.fetch).toHaveBeenCalledWith(
      ROLE_LOG_CHANNEL_ID
    );
    expect(mockDiscordChannel.send).toHaveBeenCalledWith({
      content: `❌ Failed to add <@&${UNVERIFIED_ROLE_ID}> to <@member123>: Missing Permissions`,
      allowedMentions: { parse: [] },
    });
  });

  test('replaces unverified with verified for an introduction thread creator', async () => {
    const { addRole, fetchMember, removeRole, roleOperations, thread } =
      createMockThread();

    const assigned = await verifyIntroductionThreadCreator(thread);

    expect(assigned).toBe(true);
    expect(fetchMember).toHaveBeenCalledWith('member123');
    expect(addRole).toHaveBeenCalledWith(
      VERIFIED_ROLE_ID,
      'Created a thread in the introduce-yourself channel'
    );
    expect(removeRole).toHaveBeenCalledWith(
      UNVERIFIED_ROLE_ID,
      'Completed introduction by creating a thread'
    );
    expect(roleOperations).toEqual([
      `add:${VERIFIED_ROLE_ID}`,
      `remove:${UNVERIFIED_ROLE_ID}`,
    ]);
  });

  test('ignores threads created outside the introduction channel', async () => {
    const { addRole, fetchMember, removeRole, thread } = createMockThread({
      parentId: 'another-channel',
    });

    const assigned = await verifyIntroductionThreadCreator(thread);

    expect(assigned).toBe(false);
    expect(fetchMember).not.toHaveBeenCalled();
    expect(addRole).not.toHaveBeenCalled();
    expect(removeRole).not.toHaveBeenCalled();
  });

  test('ignores threads without a creator', async () => {
    const { addRole, fetchMember, removeRole, thread } = createMockThread({
      ownerId: null,
    });

    const assigned = await verifyIntroductionThreadCreator(thread);

    expect(assigned).toBe(false);
    expect(fetchMember).not.toHaveBeenCalled();
    expect(addRole).not.toHaveBeenCalled();
    expect(removeRole).not.toHaveBeenCalled();
  });

  test('only removes unverified from an already verified member', async () => {
    const { addRole, fetchMember, removeRole, thread } = createMockThread({
      hasVerifiedRole: true,
    });

    const updated = await verifyIntroductionThreadCreator(thread);

    expect(updated).toBe(true);
    expect(fetchMember).toHaveBeenCalledWith('member123');
    expect(addRole).not.toHaveBeenCalled();
    expect(removeRole).toHaveBeenCalledWith(
      UNVERIFIED_ROLE_ID,
      'Completed introduction by creating a thread'
    );
  });

  test('does nothing when the member is already fully verified', async () => {
    const { addRole, removeRole, thread } = createMockThread({
      hasVerifiedRole: true,
      hasUnverifiedRole: false,
    });

    const updated = await verifyIntroductionThreadCreator(thread);

    expect(updated).toBe(false);
    expect(addRole).not.toHaveBeenCalled();
    expect(removeRole).not.toHaveBeenCalled();
  });

  test('does not assign the role to bots', async () => {
    const { addRole, removeRole, thread } = createMockThread({ isBot: true });

    const assigned = await verifyIntroductionThreadCreator(thread);

    expect(assigned).toBe(false);
    expect(addRole).not.toHaveBeenCalled();
    expect(removeRole).not.toHaveBeenCalled();
  });

  test('registers a member-join listener', async () => {
    const { addRole, member } = createMockMember();
    registerVerificationListeners(mockDiscordClient as unknown as Client);

    const handled = await mockDiscordClient.emit('guildMemberAdd', member);

    expect(handled).toBe(true);
    expect(addRole).toHaveBeenCalledWith(
      UNVERIFIED_ROLE_ID,
      'Joined the server'
    );
  });

  test('logs when a tracked role is gained', async () => {
    const { member: oldMember } = createMockMember();
    const { member: newMember } = createMockMember({
      hasVerifiedRole: true,
    });
    registerVerificationListeners(mockDiscordClient as unknown as Client);

    await mockDiscordClient.emit('guildMemberUpdate', oldMember, newMember);

    expect(mockDiscordClient.channels.fetch).toHaveBeenCalledWith(
      ROLE_LOG_CHANNEL_ID
    );
    expect(mockDiscordChannel.send).toHaveBeenCalledWith({
      content: `<@member123> gained the <@&${VERIFIED_ROLE_ID}> role (verified).`,
      allowedMentions: { parse: [] },
    });
  });

  test('logs when a tracked role is lost', async () => {
    const { member: oldMember } = createMockMember({
      hasUnverifiedRole: true,
    });
    const { member: newMember } = createMockMember();
    registerVerificationListeners(mockDiscordClient as unknown as Client);

    await mockDiscordClient.emit('guildMemberUpdate', oldMember, newMember);

    expect(mockDiscordChannel.send).toHaveBeenCalledWith({
      content: `<@member123> lost the <@&${UNVERIFIED_ROLE_ID}> role (unverified).`,
      allowedMentions: { parse: [] },
    });
  });

  test('does not log member updates without tracked role changes', async () => {
    const { member: oldMember } = createMockMember();
    const { member: newMember } = createMockMember();
    registerVerificationListeners(mockDiscordClient as unknown as Client);

    await mockDiscordClient.emit('guildMemberUpdate', oldMember, newMember);

    expect(mockDiscordClient.channels.fetch).not.toHaveBeenCalled();
    expect(mockDiscordChannel.send).not.toHaveBeenCalled();
  });

  test('registers a thread-create listener', async () => {
    const { addRole, thread } = createMockThread();
    registerVerificationListeners(mockDiscordClient as unknown as Client);

    const handled = await mockDiscordClient.emit('threadCreate', thread, true);

    expect(handled).toBe(true);
    expect(addRole).toHaveBeenCalledTimes(1);
  });

  test('ignores an existing thread when the bot gains access to it', async () => {
    const { addRole, thread } = createMockThread();
    registerVerificationListeners(mockDiscordClient as unknown as Client);

    await mockDiscordClient.emit('threadCreate', thread, false);

    expect(addRole).not.toHaveBeenCalled();
  });
});
