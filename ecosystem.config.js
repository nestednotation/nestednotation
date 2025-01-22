module.exports = {
  apps: [
    {
      script: 'bin/www', // the path of the script you want to execute,
      name: 'development',
      env: {
        NODE_ENV: 'development',
        PORT:3001,
        WS_PORT:2382,
        SERVER_IP:'devapi.nestednotation.com'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT:3000,
        WS_PORT:2381,
        SERVER_IP:'proapi.nestednotation.com'
<<<<<<< HEAD
      },,
      
=======
      },
>>>>>>> 13a375050efec185e1e2cca226f361df2e0efb13
    },
  ],
};
