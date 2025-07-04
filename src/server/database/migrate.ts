import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import mysql from 'mysql2/promise';
import { config } from '../config/index.js';

interface Migration {
  version: number;
  description: string;
  sql: string;
}

class DatabaseMigrator {
  private connection: mysql.Connection | null = null;

  async connect(): Promise<void> {
    try {
      this.connection = await mysql.createConnection({
        host: config.database.host,
        port: config.database.port,
        user: config.database.user,
        password: config.database.password,
        multipleStatements: true,
      });
      
      console.log('Connected to MySQL server');
    } catch (error) {
      console.error('Failed to connect to MySQL:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
      console.log('Disconnected from MySQL server');
    }
  }

  async createDatabase(): Promise<void> {
    if (!this.connection) {
      throw new Error('No database connection');
    }

    try {
      // Create database if it doesn't exist
      await this.connection.execute(
        `CREATE DATABASE IF NOT EXISTS ${config.database.database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      
      // Use the database
      await this.connection.execute(`USE ${config.database.database}`);
      
      console.log(`Database ${config.database.database} created/selected`);
    } catch (error) {
      console.error('Failed to create database:', error);
      throw error;
    }
  }

  async createMigrationsTable(): Promise<void> {
    if (!this.connection) {
      throw new Error('No database connection');
    }

    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS migrations (
        version INT PRIMARY KEY,
        description VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    try {
      await this.connection.execute(createTableSQL);
      console.log('Migrations table created/verified');
    } catch (error) {
      console.error('Failed to create migrations table:', error);
      throw error;
    }
  }

  async getAppliedMigrations(): Promise<number[]> {
    if (!this.connection) {
      throw new Error('No database connection');
    }

    try {
      const [rows] = await this.connection.execute(
        'SELECT version FROM migrations ORDER BY version'
      );
      
      return (rows as any[]).map(row => row.version);
    } catch (error) {
      console.error('Failed to get applied migrations:', error);
      throw error;
    }
  }

  async applyMigration(migration: Migration): Promise<void> {
    if (!this.connection) {
      throw new Error('No database connection');
    }

    try {
      // Execute the migration SQL
      await this.connection.execute(migration.sql);
      
      // Record the migration as applied
      await this.connection.execute(
        'INSERT INTO migrations (version, description) VALUES (?, ?)',
        [migration.version, migration.description]
      );
      
      console.log(`Applied migration ${migration.version}: ${migration.description}`);
    } catch (error) {
      console.error(`Failed to apply migration ${migration.version}:`, error);
      throw error;
    }
  }

  async runMigrations(): Promise<void> {
    const migrations = this.getMigrations();
    const appliedMigrations = await this.getAppliedMigrations();
    
    const pendingMigrations = migrations.filter(
      migration => !appliedMigrations.includes(migration.version)
    );

    if (pendingMigrations.length === 0) {
      console.log('No pending migrations');
      return;
    }

    console.log(`Found ${pendingMigrations.length} pending migrations`);

    for (const migration of pendingMigrations) {
      await this.applyMigration(migration);
    }

    console.log('All migrations applied successfully');
  }

  private getMigrations(): Migration[] {
    // Initial schema migration
    const schemaPath = join(process.cwd(), 'src/server/database/schema.sql');
    const schemaSQL = readFileSync(schemaPath, 'utf8');

    return [
      {
        version: 1,
        description: 'Initial schema',
        sql: schemaSQL,
      },
      // Add more migrations here as needed
    ];
  }

  async resetDatabase(): Promise<void> {
    if (!this.connection) {
      throw new Error('No database connection');
    }

    try {
      // Drop database
      await this.connection.execute(`DROP DATABASE IF EXISTS ${config.database.database}`);
      console.log(`Database ${config.database.database} dropped`);
      
      // Recreate database
      await this.createDatabase();
      
      // Recreate migrations table
      await this.createMigrationsTable();
      
      console.log('Database reset completed');
    } catch (error) {
      console.error('Failed to reset database:', error);
      throw error;
    }
  }
}

async function main() {
  const migrator = new DatabaseMigrator();
  
  try {
    await migrator.connect();
    await migrator.createDatabase();
    await migrator.createMigrationsTable();
    
    const args = process.argv.slice(2);
    
    if (args.includes('--reset')) {
      console.log('Resetting database...');
      await migrator.resetDatabase();
    }
    
    await migrator.runMigrations();
    
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await migrator.disconnect();
  }
}

// Run migrations if this file is executed directly
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { DatabaseMigrator };