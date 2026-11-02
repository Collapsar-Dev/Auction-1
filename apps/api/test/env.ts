process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://auction:auction@localhost:5432/auction_test';
process.env.STORAGE_DIR = require('path').resolve(__dirname, '../.test-storage');
process.env.SCHEDULER = 'off';
