import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { LoginSchema } from 'shared';
import { AuthService } from '../services/auth';
import { getDataDir } from '../utils/storage';
import { getJwtSecret, authMiddleware, isAuthRequired, getServerPassword } from '../middleware/auth';
import { timingSafeStringEqual } from '../utils/timing-safe-equal';

const auth = new Hono();

// Check if authentication is required
auth.get('/required', (c) => {
  return c.json({ required: isAuthRequired() });
});

// Login with server password
auth.post(
  '/login',
  zValidator('json', LoginSchema),
  async (c) => {
    const { password } = c.req.valid('json');
    const serverPassword = getServerPassword();

    // If no server password is set, reject login (auth not enabled)
    if (!serverPassword) {
      return c.json({ error: 'Authentication not enabled' }, 400);
    }

    // Check against server password (constant-time)
    if (!timingSafeStringEqual(password, serverPassword)) {
      return c.json({ error: 'Invalid password' }, 401);
    }

    // Generate token
    const authService = new AuthService(getDataDir(), getJwtSecret());
    const token = await authService.generateTokenForUser('user');

    return c.json({ token });
  }
);

auth.post('/logout', authMiddleware, async (c) => {
  // Stateless JWT - client should discard the token
  return c.json({ success: true });
});

auth.get('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  return c.json({ user: { id: user.userId, username: user.username } });
});

export { auth };
