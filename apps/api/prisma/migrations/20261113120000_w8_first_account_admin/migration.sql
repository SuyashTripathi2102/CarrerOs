-- W8: the first account administers the install.
--
-- Promotes the oldest account (by "createdAt", then id) to ADMIN, once:
--   - if an ADMIN already exists, nothing changes: no second ADMIN, and no account is ever demoted;
--   - if there are no accounts, nothing changes;
--   - otherwise exactly one account, the oldest, becomes ADMIN.
-- Running it again finds that ADMIN and changes nothing. It takes the sign-up lock that
-- UsersRepository.createUnderSignupLock takes, so no sign-up can run in between. The outcome is
-- reported with RAISE NOTICE; the API also logs the ADMIN count at every start (AuthService).
DO $w8$
DECLARE
  promoted text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('careeros-signup', 0));
  IF EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN') THEN
    RAISE NOTICE 'W8 admin promotion: skipped, an ADMIN account already exists';
  ELSIF NOT EXISTS (SELECT 1 FROM users) THEN
    RAISE NOTICE 'W8 admin promotion: skipped, there are no accounts';
  ELSE
    UPDATE users SET role = 'ADMIN', "updatedAt" = now()
    WHERE id = (SELECT id FROM users ORDER BY "createdAt", id LIMIT 1)
    RETURNING id INTO promoted;
    RAISE NOTICE 'W8 admin promotion: promoted the oldest account (id %) to ADMIN', promoted;
  END IF;
END
$w8$;
