'use strict';
// COMBAIN v2 — структурированные логи (winston).
// Prod: JSON в stdout + ротация файлов в LOG_DIR (14 дней, 20 МБ/файл).
// Dev:  человекочитаемый формат с цветами.
// Тесты: LOG_SILENT=true отключает все транспорты.
const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');

const isProd = process.env.NODE_ENV === 'production';
const logDir = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.join(__dirname, '..', '..', 'data', 'logs');
const level = process.env.LOG_LEVEL || 'http';

const fileRotate = new winston.transports.DailyRotateFile({
  dirname: logDir,
  filename: 'combain-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  maxSize: '20m',
  zippedArchive: true,
  level,
});

const logger = winston.createLogger({
  level,
  silent: process.env.LOG_SILENT === 'true',
  defaultMeta: { service: 'combain', env: process.env.NODE_ENV || 'development' },
  transports: [
    new winston.transports.Console({
      format: isProd
        ? winston.format.json()
        : winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp({ format: 'HH:mm:ss' }),
            winston.format.printf(({ timestamp, level: lv, message, ...meta }) => {
              const rest = Object.keys(meta).filter((k) => k !== 'service' && k !== 'env');
              const tail = rest.length
                ? ' ' + JSON.stringify(Object.fromEntries(rest.map((k) => [k, meta[k]])))
                : '';
              return `${timestamp} ${lv} ${message}${tail}`;
            })
          ),
    }),
    fileRotate,
  ],
});

module.exports = logger;
