import vue from '@vitejs/plugin-vue'

export default defineNuxtConfig({
  extends: '../base',

  compatibilityDate: '2025-01-24',

  hub: {
    db: {
      dialect: 'postgresql',
      // Migrations run separately via the dedicated migrate image
      // (`docker compose run --rm migrate`), not during the build. Without
      // this, @nuxthub/core tries to connect to DATABASE_URL and apply
      // migrations while the image builds -- there is nothing listening on
      // that placeholder connection in the CI builder container.
      applyMigrationsDuringBuild: false,
    },
  },

  ssr: false,

  nitro: {
    experimental: {
      openAPI: true
    },
    rollupConfig: {
      // @ts-expect-error - this is not typed
      plugins: [vue()]
    },
    imports: {
      dirs: ['./server/services']
    }
  },

  css: ['~/assets/css/index.css'],

  runtimeConfig: {
    private: {
      resendApiKey: '',
      resendWebhookSecret: '',
      encryptionKey: '',
      adminEmails: '',
      senderEmail: '',
      allowedOrigins: '',
      github: {
        privateKey: '',
      }
    },
    oauth: {
      google: {
        clientId: '',
        clientSecret: '',
      },
      github: {
        clientId: '',
        clientSecret: '',
      },
    }
  },

  $development: {
    runtimeConfig: {
      public: {
        github: {
          appName: 'shelve-local',
        },
      },
    },
  },

  $production: {
    runtimeConfig: {
      public: {
        github: {
          appName: 'shelve-cloud',
        },
      },
    },
  },

  image: {
    format: ['webp', 'jpeg', 'jpg', 'png', 'svg']
  },

  modules: ['@nuxt/ui', 'nuxt-auth-utils', '@nuxthub/core', 'botid/nuxt'],

  $test: {
    modules: ['nuxt-auth-utils', '@nuxthub/core'],
    hub: {
      db: {
        dialect: 'postgresql',
        driver: 'pglite',
      },
    },
  },
})
