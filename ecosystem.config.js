module.exports = {
  apps: [
    {
      script: 'bin/www', // the path of the script you want to execute,
      name: 'development',
      env: {
        NODE_ENV: 'development',
      },
      
    },
  ],
};
