/**
 * Users Data Access Layer
 * CRUD operations for users
 */

import { prisma, User, UserRole, Prisma } from '../client';
import * as bcrypt from 'bcrypt';

const SALT_ROUNDS = 10;

export interface CreateUserInput {
  email: string;
  username: string;
  password: string;
  role?: UserRole;
  walletAddress?: string;
}

export interface UpdateUserInput {
  email?: string;
  username?: string;
  password?: string;
  role?: UserRole;
  walletAddress?: string;
  isActive?: boolean;
}

/**
 * Create a new user
 */
export async function createUser(input: CreateUserInput): Promise<User> {
  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  return prisma.user.create({
    data: {
      email: input.email,
      username: input.username,
      passwordHash,
      role: input.role || 'TRADER',
      walletAddress: input.walletAddress,
    },
  });
}

/**
 * Find user by ID
 */
export async function findUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { id },
    include: {
      strategies: true,
      paperTradingSessions: true,
    },
  });
}

/**
 * Find user by email
 */
export async function findUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { email },
  });
}

/**
 * Find user by username
 */
export async function findUserByUsername(username: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { username },
  });
}

/**
 * Find user by wallet address
 */
export async function findUserByWalletAddress(walletAddress: string): Promise<User | null> {
  return prisma.user.findFirst({
    where: { walletAddress },
  });
}

/**
 * Update user
 */
export async function updateUser(id: string, input: UpdateUserInput): Promise<User> {
  const data: Prisma.UserUpdateInput = {
    ...input,
  };

  if (input.password) {
    data.passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
    delete (data as any).password;
  }

  return prisma.user.update({
    where: { id },
    data,
  });
}

/**
 * Delete user
 */
export async function deleteUser(id: string): Promise<User> {
  return prisma.user.delete({
    where: { id },
  });
}

/**
 * List all users (with pagination)
 */
export async function listUsers(
  page: number = 1,
  limit: number = 50,
  filters?: {
    role?: UserRole;
    isActive?: boolean;
  }
): Promise<{ users: User[]; total: number; pages: number }> {
  const skip = (page - 1) * limit;

  const where: Prisma.UserWhereInput = {};
  if (filters?.role) where.role = filters.role;
  if (filters?.isActive !== undefined) where.isActive = filters.isActive;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users,
    total,
    pages: Math.ceil(total / limit),
  };
}

/**
 * Verify user password
 */
export async function verifyUserPassword(
  email: string,
  password: string
): Promise<User | null> {
  const user = await findUserByEmail(email);
  if (!user) return null;

  const isValid = await bcrypt.compare(password, user.passwordHash);
  return isValid ? user : null;
}

/**
 * Add API key to user
 */
export async function addApiKey(userId: string, apiKey: string): Promise<User> {
  const user = await findUserById(userId);
  if (!user) throw new Error('User not found');

  return prisma.user.update({
    where: { id: userId },
    data: {
      apiKeys: {
        push: apiKey,
      },
    },
  });
}

/**
 * Remove API key from user
 */
export async function removeApiKey(userId: string, apiKey: string): Promise<User> {
  const user = await findUserById(userId);
  if (!user) throw new Error('User not found');

  const updatedKeys = user.apiKeys.filter(key => key !== apiKey);

  return prisma.user.update({
    where: { id: userId },
    data: {
      apiKeys: updatedKeys,
    },
  });
}

/**
 * Get user statistics
 */
export async function getUserStats(userId: string) {
  const [
    strategyCount,
    tradeCount,
    paperSessionCount,
    totalPnL,
  ] = await Promise.all([
    prisma.strategy.count({ where: { userId } }),
    prisma.trade.count({ where: { userId } }),
    prisma.paperTradingSession.count({ where: { userId } }),
    prisma.trade.aggregate({
      where: { userId, profitLoss: { not: null } },
      _sum: { profitLoss: true, profitLossUSD: true },
    }),
  ]);

  return {
    strategies: strategyCount,
    trades: tradeCount,
    paperSessions: paperSessionCount,
    totalPnL: totalPnL._sum.profitLoss || 0,
    totalPnLUSD: totalPnL._sum.profitLossUSD || 0,
  };
}