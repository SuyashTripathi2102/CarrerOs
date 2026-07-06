from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    redis_url: str = "redis://localhost:6379"
    api_internal_url: str = "http://localhost:3001/api/internal"
    api_internal_token: str = "change-me"
    port: int = 8000


settings = Settings()
