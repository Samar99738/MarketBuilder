/**
 * Authentication Routes
 * Handles user registration, login, and profile management
 */

import { Router, Response } from 'express';
import { createUser, verifyUserPassword, findUserByEmail, findUserByUsername } from '../../database/dal';
import { generateToken, authenticate, AuthRequest } from '../middleware/auth';
import { logUserAction } from '../../database/dal/auditLogs';

const router = Router();

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', async (req, res: Response) => {
  try {
    const { email, username, password, walletAddress } = req.body;

    // Validation
    if (!email || !username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email, username, and password are required.',
      });
    }

    // Password strength validation
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters long.',
      });
    }

    // Check if email already exists
    const existingEmail = await findUserByEmail(email);
    if (existingEmail) {
      return res.status(400).json({
        success: false,
        error: 'Email already registered.',
      });
    }

    // Check if username already exists
    const existingUsername = await findUserByUsername(username);
    if (existingUsername) {
      return res.status(400).json({
        success: false,
        error: 'Username already taken.',
      });
    }

    // Create user
    const user = await createUser({
      email,
      username,
      password,
      walletAddress,
      role: 'TRADER',
    });

    // Log registration
    await logUserAction(
      user.id,
      'user.registered',
      'user',
      user.id,
      { email, username },
      req
    );

    // Generate token
    const token = generateToken(user.id);

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        walletAddress: user.walletAddress,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Registration failed. Please try again.',
    });
  }
});

/**
 * POST /api/auth/login
 * Login with email and password
 */
router.post('/login', async (req, res: Response) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required.',
      });
    }

    // Verify credentials
    const user = await verifyUserPassword(email, password);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password.',
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        error: 'Account is inactive. Please contact support.',
      });
    }

    // Log login
    await logUserAction(
      user.id,
      'user.logged_in',
      'user',
      user.id,
      { email },
      req
    );

    // Generate token
    const token = generateToken(user.id);

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        walletAddress: user.walletAddress,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed. Please try again.',
    });
  }
});

/**
 * GET /api/auth/me
 * Get current user profile (protected route)
 */
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Not authenticated.',
      });
    }

    res.json({
      success: true,
      user: req.user,
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get profile.',
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout (client-side token removal, server logs the action)
 */
router.post('/logout', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user) {
      // Log logout
      await logUserAction(
        req.user.id,
        'user.logged_out',
        'user',
        req.user.id,
        {},
        req
      );
    }

    res.json({
      success: true,
      message: 'Logged out successfully. Please remove token from client.',
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      error: 'Logout failed.',
    });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh JWT token (protected route)
 */
router.post('/refresh', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Not authenticated.',
      });
    }

    // Generate new token
    const token = generateToken(req.user.id);

    res.json({
      success: true,
      token,
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({
      success: false,
      error: 'Token refresh failed.',
    });
  }
});

export default router;