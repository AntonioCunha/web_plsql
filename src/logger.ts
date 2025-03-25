import * as path from 'path';
import * as fs from 'fs';
import { createRollingFileLogger } from 'simple-node-logger';

class Logger {
  private static instance: Logger;
  private logger;

  private constructor() {
    const logDir = path.resolve('logs', 'plsql');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }


    this.logger = createRollingFileLogger({
      logDirectory: logDir,
      fileNamePattern: 'YYYYMMDD.log',
      timestampFormat: 'YYYY-MM-DD HH:mm:ss.SSS'
    });

    // Remover saída para a consola
    this.logger.removeConsoleAppender();
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  public trace(message: string): void {
    this.logger.trace(message);
  }

  public debug(message: string): void {
    this.logger.debug(message);
  }

  public info(message: string): void {
    this.logger.info(message);
  }

  public warn(message: string): void {
    this.logger.warn(message);
  }

  public error(message: string): void {
    this.logger.error(message);
  }
}

export default Logger.getInstance();
