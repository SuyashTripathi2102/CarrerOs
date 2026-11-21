import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import helmet from 'helmet';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppModule } from './app.module';
import { listenHost } from './common/listen-host';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());
  // Crawler sync payloads (hundreds of job descriptions) exceed the 100kb default.
  app.use(json({ limit: '20mb' }));
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true, credentials: true });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Containers stop with SIGTERM — drain BullMQ processors + close Prisma cleanly.
  app.enableShutdownHooks();

  // Loopback unless told otherwise: on a laptop, every interface means everyone
  // on the same Wi-Fi. A container must set HOST=0.0.0.0 for its published port.
  // A HOST that is not an address stops the start (see listenHost).
  const host = listenHost(process.env.HOST);
  await app.listen(process.env.PORT ?? 3001, host.address);

  const logger = new Logger('Bootstrap');
  const bound = (app.getHttpServer() as Server).address() as AddressInfo;
  logger.log(`API listening on ${bound.address}:${bound.port}`);
  if (!host.loopback) {
    logger.warn(
      `${bound.address} is not a loopback address: anything that can reach this machine on port ${bound.port} can reach the API. ` +
        'Expected inside a container (the Dockerfile sets HOST=0.0.0.0); elsewhere, leave HOST empty for 127.0.0.1.',
    );
  }
}
// A refused start (an invalid HOST, among others) is logged and ends the process with status 1.
bootstrap().catch((err: unknown) => {
  new Logger('Bootstrap').error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
