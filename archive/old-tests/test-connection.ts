import { connectDatabase, prisma, disconnectDatabase, getDatabaseStats } from '../../src/database/client';

async function testConnection() {
  console.log('🔍 Testing database connection...\n');
  
  try {
    await connectDatabase();
    console.log('✅ Database connected successfully\n');

    // Test query
    const result: any = await prisma.$queryRaw`SELECT NOW() as current_time`;
    console.log('✅ Query test passed');
    console.log(`   Current time: ${result[0].current_time}\n`);

    // Get database stats
    const stats = await getDatabaseStats();
    console.log('📊 Database Statistics:');
    console.log(`   Users: ${stats?.users || 0}`);
    console.log(`   Strategies: ${stats?.strategies || 0}`);
    console.log(`   Trades: ${stats?.trades || 0}`);
    console.log(`   Paper Sessions: ${stats?.paperSessions || 0}\n`);

    await disconnectDatabase();
    console.log('✅ All tests passed!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testConnection();