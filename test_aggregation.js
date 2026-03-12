// Test script for aggregated usage functionality
import { aggregateAccountUsages } from './dist/quota.js';

// Test data - mock accounts with different usage levels
const testAccounts = [
    {
        id: 'account1',
        enabled: true,
        usage: {
            primary: { usedPercent: 20, resetAt: Date.now() + 3600000 },
            secondary: { usedPercent: 15, resetAt: Date.now() + 86400000 },
            fetchedAt: Date.now()
        }
    },
    {
        id: 'account2',
        enabled: true,
        usage: {
            primary: { usedPercent: 30, resetAt: Date.now() + 3600000 },
            secondary: { usedPercent: 25, resetAt: Date.now() + 86400000 },
            fetchedAt: Date.now()
        }
    },
    {
        id: 'account3',
        enabled: true,
        usage: {
            primary: { usedPercent: 10, resetAt: Date.now() + 3600000 },
            secondary: { usedPercent: 5, resetAt: Date.now() + 86400000 },
            fetchedAt: Date.now()
        }
    }
];

console.log('Testing aggregateAccountUsages function...');
console.log('Input accounts:', testAccounts.map(a => ({ id: a.id, usage: a.usage })));

const result = aggregateAccountUsages(testAccounts);
console.log('Aggregated result:', result);

// Expected: primary = (20+30+10)/3 = 20, secondary = (15+25+5)/3 = 15
console.log('Expected primary usedPercent: 20');
console.log('Actual primary usedPercent:', result.primary.usedPercent);
console.log('Expected secondary usedPercent: 15');
console.log('Actual secondary usedPercent:', result.secondary.usedPercent);

// Test with empty array
console.log('\nTesting with empty array...');
const emptyResult = aggregateAccountUsages([]);
console.log('Empty result:', emptyResult);

// Test with one account
console.log('\nTesting with one account...');
const singleAccountResult = aggregateAccountUsages([testAccounts[0]]);
console.log('Single account result:', singleAccountResult);

console.log('\nAll tests completed!');