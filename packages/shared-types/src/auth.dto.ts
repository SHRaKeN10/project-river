import { z } from 'zod';

/** Shared auth request/response contracts. The API validates with these exact
 * schemas; the mobile app reuses them for client-side form validation. */

export const registerSchema = z.object({
  email: z.string().email().max(254),
  username: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_]+$/, 'letters, numbers and underscore only'),
  password: z.string().min(10).max(128),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  emailOrUsername: z.string().min(3).max(254),
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const passwordResetRequestSchema = z.object({
  email: z.string().email().max(254),
});
export type PasswordResetRequestInput = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(10).max(128),
});
export type PasswordResetConfirmInput = z.infer<typeof passwordResetConfirmSchema>;

export const emailVerificationConfirmSchema = z.object({
  token: z.string().min(1),
});
export type EmailVerificationConfirmInput = z.infer<typeof emailVerificationConfirmSchema>;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime in seconds, from JWT_ACCESS_TTL. */
  expiresIn: number;
}

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  role: string;
  avatarUrl: string | null;
  status: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface AuthResponse {
  user: PublicUser;
  tokens: AuthTokens;
}
