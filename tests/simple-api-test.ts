/**
 * Simple API Test
 */

// MUST import config first to load .env file
import '../src/config/environment';
import { aiModelManager } from '../src/agent/aiModelManager';

console.log('\n=== Testing Gemini API ===\n');

async function test() {
  try {
    console.log('Sending test prompt to AI...');
    const response = await aiModelManager.generateResponse('Say "Hello" in one word');
    
    console.log('\n✅ SUCCESS!');
    console.log('Provider:', response.provider);
    console.log('Model:', response.model);
    console.log('Response:', response.text);
    
    // Get stats
    const stats = aiModelManager.getProviderStats();
    console.log('\nProvider Stats:');
    stats.forEach(stat => {
      console.log(`- ${stat.name}: ${stat.successCount} success, ${stat.errorCount} errors`);
      if (stat.lastError) {
        console.log(`  Last error: ${stat.lastError.substring(0, 100)}`);
      }
    });
    
  } catch (error: any) {
    console.log('\n❌ FAILED!');
    console.log('Error:', error.message);
    
    // Get stats
    const stats = aiModelManager.getProviderStats();
    console.log('\nProvider Stats:');
    stats.forEach(stat => {
      console.log(`- ${stat.name}: ${stat.successCount} success, ${stat.errorCount} errors`);
      if (stat.lastError) {
        console.log(`  Last error: ${stat.lastError.substring(0, 150)}`);
      }
    });
  }
}

test();
