import fs from 'fs';
import path from 'path';
import { GetFormattedDate, GetMillisecondsUntilMidnight } from './Dates';

type LogLevel = 'minimal' | 'normal' | 'all';

type MetaType = { [key: string]: object | string | number | unknown };

const GLOG_LEVELS = {
    ERROR: 'ERROR',
    WARN: 'WARN',
    INFO: 'INFO',
    DEBUG: 'DEBUG'
};

export const GLOG_TYPES = {
    TCPServer: 'TCP-SERVER'
};

let LOG_LEVEL: LogLevel = 'normal';
let LOG_DIR = './logs';
let KEEP_DAYS = 7;
let timeout: NodeJS.Timeout | null = null;
let interval: NodeJS.Timeout | null = null;
const LogStreams: { [key: string]: fs.WriteStream } = {};

function OpenLogs(logLevel: LogLevel, logDir: string, keepDays: number) {
    LOG_LEVEL = logLevel;
    LOG_DIR = logDir;
    KEEP_DAYS = keepDays;

    // Create the log directory if it doesn't exists
    fs.mkdirSync(LOG_DIR, { recursive: true });

    // Create a writing flow in append mode
    for (const type of Object.values(GLOG_TYPES)) {
        const fullPath = getLogFileName(type);
        LogStreams[type] = fs.createWriteStream(fullPath, { flags: 'a' });
    }

    // Schedule the rotation
    for (const type of Object.values(GLOG_TYPES)) {
        rotateLogFile(type);
    }
    timeout = setTimeout(() => {
        for (const type of Object.values(GLOG_TYPES)) {
            rotateLogFile(type);
        }
        interval = setInterval(
            () => {
                for (const type of Object.values(GLOG_TYPES)) {
                    rotateLogFile(type);
                }
            },
            24 * 60 * 60 * 1000
        ); // Every 24 hours
    }, GetMillisecondsUntilMidnight());
}

function CloseLogs() {
    if (timeout) {
        clearTimeout(timeout);
    }
    if (interval) {
        clearInterval(interval);
    }
    for (const type of Object.values(GLOG_TYPES)) {
        if (LogStreams[type]) {
            LogStreams[type].end();
            delete LogStreams[type];
        }
    }
}

function getLogFileName(type: string) {
    const date = new Date();
    const year = date.getFullYear();
    const month = `0${date.getMonth() + 1}`.slice(-2);
    const day = `0${date.getDate()}`.slice(-2);
    return path.join(LOG_DIR, `${year}-${month}-${day}-${type}.log`);
}

function rotateLogFile(type: string) {
    // Close the current log stream and create a new one
    const newLogStream = fs.createWriteStream(getLogFileName(type), { flags: 'a' });

    // Update the log stream
    const oldLogStream = LogStreams[type];
    LogStreams[type] = newLogStream;

    // Close the old log stream
    oldLogStream.end();

    // Log the rotation
    _log(GLOG_LEVELS.INFO, GLOG_TYPES.TCPServer, `[Logs] File rotated (${type})`);

    // Remove old log files (remove after LOG_KEEP_DAYS days)
    let removedFiles = 0;
    const files = fs.readdirSync(LOG_DIR);
    const today = new Date();
    files.forEach((file) => {
        const filePath = path.join(LOG_DIR, file);
        const stats = fs.statSync(filePath);
        const fileDate = new Date(stats.mtime);
        const daysOld = (today.getTime() - fileDate.getTime()) / (24 * 60 * 60 * 1000);
        if (daysOld > KEEP_DAYS) {
            removedFiles++;
            fs.unlinkSync(filePath);
            _log(GLOG_LEVELS.INFO, GLOG_TYPES.TCPServer, `[Logs] Remove "${file}"`);
        }
    });

    // Log the cleanup
    if (removedFiles > 0) {
        _log(GLOG_LEVELS.INFO, GLOG_TYPES.TCPServer, `[Logs] ${removedFiles} log files removed`);
    }
}

function _log(level: string, type: (typeof GLOG_TYPES)[keyof typeof GLOG_TYPES], message: string, meta: MetaType = {}) {
    // Log to the console
    let consoleArgs = null;
    if (LOG_LEVEL === 'all') {
        const metaKeys = Object.keys(meta);
        if (metaKeys.length > 1) {
            const firstKey = metaKeys[0];
            consoleArgs = { [firstKey]: meta[firstKey], '...': 'more in log file' };
        } else if (metaKeys.length === 1) {
            consoleArgs = meta;
        }
    }

    if (level === GLOG_LEVELS.ERROR) {
        console.error(message, consoleArgs || '');
    } else if (level === GLOG_LEVELS.WARN && (LOG_LEVEL === 'normal' || LOG_LEVEL === 'all')) {
        console.warn(message, consoleArgs || '');
    } else if (level === GLOG_LEVELS.INFO && (LOG_LEVEL === 'normal' || LOG_LEVEL === 'all')) {
        console.log(message, consoleArgs || '');
    } else if (level === GLOG_LEVELS.DEBUG && LOG_LEVEL === 'all') {
        console.log(message, consoleArgs || '');
    }

    // Not initialized
    if (!LogStreams || Object.keys(LogStreams).length === 0 || !LogStreams[type]) {
        return;
    }

    // Old log stream
    if (!LogStreams[type] || LogStreams[type].writableEnded || LogStreams[type].destroyed) {
        console.error(`[Log] Attempted to write to a closed stream for type ${type}`);
        return;
    }

    // Create a log object
    let logLine = '';
    try {
        const logEntry = {
            timestamp: GetFormattedDate(),
            level,
            message,
            ...meta
        };

        logLine = JSON.stringify(logEntry) + '\n';
    } catch (error) {
        console.error(`[Log] Error stringifying log entry: ${error}`);
        return;
    }

    // Write to the log file
    try {
        LogStreams[type].write(logLine);
    } catch (error) {
        console.error(`[Log] Error writing to log file: ${error}`);
    }
}

function error(
    message: string,
    meta: MetaType = {},
    type: (typeof GLOG_TYPES)[keyof typeof GLOG_TYPES] = GLOG_TYPES.TCPServer
) {
    _log(GLOG_LEVELS.ERROR, type, '\x1b[31m' + message + '\x1b[0m', meta);
}

function warn(
    message: string,
    meta: MetaType = {},
    type: (typeof GLOG_TYPES)[keyof typeof GLOG_TYPES] = GLOG_TYPES.TCPServer
) {
    _log(GLOG_LEVELS.WARN, type, '\x1b[33m' + message + '\x1b[0m', meta);
}

function success(
    message: string,
    meta: MetaType = {},
    type: (typeof GLOG_TYPES)[keyof typeof GLOG_TYPES] = GLOG_TYPES.TCPServer
) {
    _log(GLOG_LEVELS.WARN, type, '\x1b[32m' + message + '\x1b[0m', meta);
}

function info(
    message: string,
    meta: MetaType = {},
    type: (typeof GLOG_TYPES)[keyof typeof GLOG_TYPES] = GLOG_TYPES.TCPServer
) {
    _log(GLOG_LEVELS.INFO, type, message, meta);
}

function debug(
    message: string,
    meta: MetaType = {},
    type: (typeof GLOG_TYPES)[keyof typeof GLOG_TYPES] = GLOG_TYPES.TCPServer
) {
    _log(GLOG_LEVELS.DEBUG, type, message, meta);
}

const GLogs = {
    OpenLogs,
    CloseLogs,
    error,
    warn,
    success,
    info,
    debug
};

export default GLogs;
