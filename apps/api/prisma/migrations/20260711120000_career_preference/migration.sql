-- The user's standing answer to "do you want roles in this ecosystem?" — a
-- permanent career-direction signal keyed on a canonical discipline token.
-- Not every software engineer wants every software job: a .NET role can be a
-- perfect skill match and the wrong career path.
CREATE TABLE "career_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "discipline" TEXT NOT NULL,
    "preference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "career_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "career_preferences_userId_discipline_key" ON "career_preferences"("userId", "discipline");

ALTER TABLE "career_preferences" ADD CONSTRAINT "career_preferences_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
