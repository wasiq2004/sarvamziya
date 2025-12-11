const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { v4: uuidv4 } = require('uuid');

/**
 * Google OAuth Configuration
 * Handles Google Sign-In authentication
 */

function configureGoogleAuth(mysqlPool) {
    // Configure Google Strategy
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback'
    },
        async (accessToken, refreshToken, profile, done) => {
            try {
                console.log('Google OAuth callback received for:', profile.emails[0].value);

                const email = profile.emails[0].value;
                const googleId = profile.id;
                const username = profile.displayName || email.split('@')[0];

                // Check if user exists
                const [existingUsers] = await mysqlPool.execute(
                    'SELECT * FROM users WHERE email = ? OR google_id = ?',
                    [email, googleId]
                );

                let user;

                if (existingUsers.length > 0) {
                    // User exists, update google_id if not set
                    user = existingUsers[0];

                    if (!user.google_id) {
                        await mysqlPool.execute(
                            'UPDATE users SET google_id = ? WHERE id = ?',
                            [googleId, user.id]
                        );
                        user.google_id = googleId;
                    }

                    console.log('✅ Existing user logged in:', email);
                } else {
                    // Create new user
                    const userId = uuidv4();

                    await mysqlPool.execute(
                        `INSERT INTO users (id, email, username, google_id, password_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'google-oauth', NOW(), NOW())`,
                        [userId, email, username, googleId]
                    );

                    // Create wallet for new user
                    await mysqlPool.execute(
                        'INSERT INTO user_wallets (id, user_id, balance) VALUES (?, ?, 0.00)',
                        [uuidv4(), userId]
                    );

                    user = {
                        id: userId,
                        email,
                        username,
                        google_id: googleId,
                        created_at: new Date(),
                        updated_at: new Date()
                    };

                    console.log('✅ New user created via Google:', email);
                }

                return done(null, user);
            } catch (error) {
                console.error('❌ Google OAuth error:', error);
                return done(error, null);
            }
        }));

    // Serialize user for session
    passport.serializeUser((user, done) => {
        done(null, user.id);
    });

    // Deserialize user from session
    passport.deserializeUser(async (id, done) => {
        try {
            const [users] = await mysqlPool.execute(
                'SELECT id, email, username, google_id, created_at, updated_at FROM users WHERE id = ?',
                [id]
            );

            if (users.length > 0) {
                done(null, users[0]);
            } else {
                done(new Error('User not found'), null);
            }
        } catch (error) {
            done(error, null);
        }
    });

    return passport;
}

module.exports = { configureGoogleAuth };
