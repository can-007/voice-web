import { PassThrough } from 'stream';
import { S3 } from 'aws-sdk';
import * as bodyParser from 'body-parser';
import { MD5 } from 'crypto-js';
import { NextFunction, Request, Response, Router } from 'express';
import * as sendRequest from 'request-promise-native';
import { UserClient as UserClientType } from 'common/user-clients';
import { authMiddleware } from '../auth-router';
import { getConfig } from '../config-helper';
import Awards from './model/awards';
import CustomGoal from './model/custom-goal';
import getGoals from './model/goals';
import UserClient from './model/user-client';
import { AWS } from './aws';
import * as Basket from './basket';
import Bucket from './bucket';
import Clip from './clip';
import Model from './model';
import Prometheus from './prometheus';
import { ClientParameterError } from './utility';

const Transcoder = require('stream-transcoder');

const PromiseRouter = require('express-promise-router');

export default class API {
  model: Model;
  clip: Clip;
  metrics: Prometheus;
  private s3: S3;
  private bucket: Bucket;

  constructor(model: Model) {
    this.model = model;
    this.clip = new Clip(this.model);
    this.metrics = new Prometheus();
    this.s3 = AWS.getS3();
    this.bucket = new Bucket(this.model, this.s3);
  }

  getRouter(): Router {
    const router = PromiseRouter();

    router.use(bodyParser.json());

    router.use((request: Request, response: Response, next: NextFunction) => {
      this.metrics.countRequest(request);
      next();
    }, authMiddleware);

    router.get('/metrics', (request: Request, response: Response) => {
      this.metrics.countPrometheusRequest(request);

      const { registry } = this.metrics;
      response
        .type(registry.contentType)
        .status(200)
        .end(registry.metrics());
    });

    router.use((request: Request, response: Response, next: NextFunction) => {
      this.metrics.countApiRequest(request);
      next();
    });

    router.get('/golem', (request: Request, response: Response) => {
      console.log('Received a Golem request', {
        referer: request.header('Referer'),
        query: request.query,
      });
      response.redirect('/');
    });

    router.get('/user_clients', this.getUserClients);
    router.post('/user_clients/:client_id/claim', this.claimUserClient);
    router.get('/user_client', this.getAccount);
    router.patch('/user_client', this.saveAccount);
    router.post(
      '/user_client/avatar/:type',
      bodyParser.raw({ type: 'image/*' }),
      this.saveAvatar
    );
    router.post('/user_client/avatar_clip', this.saveAvatarClip);
    router.get('/user_client/avatar_clip', this.getAvatarClip);
    router.get('/user_client/delete_avatar_clip', this.deleteAvatarClip);
    router.post('/user_client/:locale/goals', this.createCustomGoal);
    router.get('/user_client/goals', this.getGoals);
    router.get('/user_client/:locale/goals', this.getGoals);
    router.post('/user_client/awards/seen', this.seenAwards);

    router.get('/:locale/sentences', this.getRandomSentences);
    router.post('/skipped_sentences/:id', this.createSkippedSentence);

    router.use(
      '/:locale?/clips',
      (request: Request, response: Response, next: NextFunction) => {
        this.metrics.countClipRequest(request);
        next();
      },
      this.clip.getRouter()
    );

    router.get('/contribution_activity', this.getContributionActivity);
    router.get('/:locale/contribution_activity', this.getContributionActivity);

    router.get('/requested_languages', this.getRequestedLanguages);
    router.post('/requested_languages', this.createLanguageRequest);

    router.get('/language_stats', this.getLanguageStats);

    router.post('/newsletter/:email', this.subscribeToNewsletter);

    router.post('/:locale/downloaders/:email', this.insertDownloader);

    router.post('/reports', this.createReport);

    router.get('/challenge/points/:email', this.getChallengePoint);
    router.get('/challenge/weekly/:email/:date', this.getWeeklyChallenge);
    router.get('/:locale/top/member/:team/:email/:type', this.getTopMembers);
    router.get('/:locale/top/teams/:type', this.getTopTeams);
    router.get(
      '/:locale/top/contributors/:email/:type',
      this.getTopContributors
    );

    return router;
  }

  getRandomSentences = async (request: Request, response: Response) => {
    const { client_id, params } = request;
    const sentences = await this.model.findEligibleSentences(
      client_id,
      params.locale,
      parseInt(request.query.count, 10) || 1
    );

    response.json(sentences);
  };

  getRequestedLanguages = async (request: Request, response: Response) => {
    response.json(await this.model.db.getRequestedLanguages());
  };

  createLanguageRequest = async (request: Request, response: Response) => {
    await this.model.db.createLanguageRequest(
      request.body.language,
      request.client_id
    );
    response.json({});
  };

  createSkippedSentence = async (request: Request, response: Response) => {
    const {
      client_id,
      params: { id },
    } = request;
    await this.model.db.createSkippedSentence(id, client_id);
    response.json({});
  };

  getLanguageStats = async (request: Request, response: Response) => {
    response.json(await this.model.getLanguageStats());
  };

  getUserClients = async ({ client_id, user }: Request, response: Response) => {
    if (!user) {
      response.json([]);
      return;
    }

    const email = user.emails[0].value;
    const userClients: UserClientType[] = [
      { email },
      ...(await UserClient.findAllWithLocales({
        email,
        client_id,
      })),
    ];
    response.json(userClients);
  };

  saveAccount = async ({ body, user }: Request, response: Response) => {
    if (!user) {
      throw new ClientParameterError();
    }
    response.json(await UserClient.saveAccount(user.emails[0].value, body));
  };

  getAccount = async ({ user }: Request, response: Response) => {
    let userData = null;
    if (user) {
      userData = await UserClient.findAccount(user.emails[0].value);
    }

    if (userData !== null && userData.avatar_clip_url !== null) {
      userData.avatar_clip_url = await this.bucket.getAvatarClipsUrl(
        userData.avatar_clip_url
      );
    }

    response.json(user ? userData : null);
  };

  subscribeToNewsletter = async (request: Request, response: Response) => {
    const { BASKET_API_KEY, PROD } = getConfig();
    if (!BASKET_API_KEY) {
      response.json({});
      return;
    }

    const { email } = request.params;
    const basketResponse = await sendRequest({
      uri: Basket.API_URL + '/news/subscribe/',
      method: 'POST',
      form: {
        'api-key': BASKET_API_KEY,
        newsletters: 'common-voice',
        format: 'H',
        lang: 'en',
        email,
        source_url: request.header('Referer'),
        sync: 'Y',
      },
    });
    await UserClient.updateBasketToken(email, JSON.parse(basketResponse).token);
    response.json({});
  };

  saveAvatar = async (
    { body, headers, params, user }: Request,
    response: Response
  ) => {
    let avatarURL;
    let error;
    switch (params.type) {
      case 'default':
        avatarURL = null;
        break;

      case 'gravatar':
        try {
          avatarURL =
            'https://gravatar.com/avatar/' +
            MD5(user.emails[0].value).toString() +
            '.png';
          await sendRequest(avatarURL + '&d=404');
        } catch (e) {
          if (e.name != 'StatusCodeError') {
            throw e;
          }
          error = 'not_found';
        }
        break;

      case 'file':
        avatarURL =
          'data:' +
          headers['content-type'] +
          ';base64,' +
          body.toString('base64');
        console.log(avatarURL.length);
        if (avatarURL.length > 8000) {
          error = 'too_large';
        }
        break;

      default:
        response.sendStatus(404);
        return;
    }

    if (!error) {
      await UserClient.updateAvatarURL(user.emails[0].value, avatarURL);
    }

    response.json(error ? { error } : {});
  };

  saveAvatarClip = async (request: Request, response: Response) => {
    const { client_id, headers, user } = request;

    const folder = client_id;
    const clipFileName = folder + '.mp3';
    try {
      // If upload was base64, make sure we decode it first.
      let transcoder;
      if ((headers['content-type'] as string).includes('base64')) {
        // If we were given base64, we'll need to concat it all first
        // So we can decode it in the next step.
        const chunks: Buffer[] = [];
        await new Promise(resolve => {
          request.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          request.on('end', resolve);
        });
        const passThrough = new PassThrough();
        passThrough.end(
          Buffer.from(Buffer.concat(chunks).toString(), 'base64')
        );
        transcoder = new Transcoder(passThrough);
      } else {
        // For non-base64 uploads, we can just stream data.
        transcoder = new Transcoder(request);
      }

      await Promise.all([
        this.s3
          .upload({
            Bucket: getConfig().BUCKET_NAME,
            Key: clipFileName,
            Body: transcoder
              .audioCodec('mp3')
              .format('mp3')
              .stream(),
          })
          .promise(),
      ]);

      await UserClient.updateAvatarClipURL(user.emails[0].value, clipFileName);

      response.json(clipFileName);
    } catch (error) {
      console.error(error);
      response.statusCode = error.statusCode || 500;
      response.statusMessage = 'save avatar clip error';
      response.json(error);
    }
  };

  getAvatarClip = async (request: Request, response: Response) => {
    try {
      const { user } = request;
      let path = await UserClient.getAvatarClipURL(user.emails[0].value);
      path = path[0][0].avatar_clip_url;

      let avatarclip = await this.bucket.getAvatarClipsUrl(path);
      response.json(avatarclip);
    } catch (err) {
      response.json(null);
    }
  };

  deleteAvatarClip = async (request: Request, response: Response) => {
    const { user } = request;
    await UserClient.deleteAvatarClipURL(user.emails[0].value);
    response.json('deleted');
  };

  getContributionActivity = async (
    { client_id, params: { locale }, query }: Request,
    response: Response
  ) => {
    response.json(
      await (query.from == 'you'
        ? this.model.db.getContributionStats(locale, client_id)
        : this.model.getContributionStats(locale))
    );
  };

  createCustomGoal = async (request: Request, response: Response) => {
    await CustomGoal.create(
      request.client_id,
      request.params.locale,
      request.body
    );
    response.json({});
    Basket.sync(request.client_id).catch(e => console.error(e));
  };

  getGoals = async (
    { client_id, params: { locale } }: Request,
    response: Response
  ) => {
    response.json({ globalGoals: await getGoals(client_id, locale) });
  };

  claimUserClient = async (
    { client_id, params }: Request,
    response: Response
  ) => {
    if (!(await UserClient.hasSSO(params.client_id)) && client_id) {
      await UserClient.claimContributions(client_id, [params.client_id]);
    }
    response.json({});
  };

  insertDownloader = async (
    { client_id, params }: Request,
    response: Response
  ) => {
    await this.model.db.insertDownloader(params.locale, params.email);
    response.json({});
  };

  seenAwards = async ({ client_id, query }: Request, response: Response) => {
    await Awards.seen(
      client_id,
      query.hasOwnProperty('notification') ? 'notification' : 'award'
    );
    response.json({});
  };

  createReport = async ({ client_id, body }: Request, response: Response) => {
    await this.model.db.createReport(client_id, body);
    response.json({});
  };

  getChallengePoint = async (
    { params: { email } }: Request,
    response: Response
  ) => {
    console.log(`[DEBUG] getChallengePoint - email:${email}`);
    response.json({ user: 448, team: 12345 });
  };

  getWeeklyChallenge = async (
    { params: { email, date } }: Request,
    response: Response
  ) => {
    console.log(
      `[DEBUG] getWeeklyChallenge - email:${email}, date:${JSON.stringify(
        date
      )}`
    );
    response.json({
      week: 1,
      user: { speak: 12, speak_total: 400, listen: 34, listen_total: 654 },
      team: { invite: 12, invite_total: 50 },
    });
  };

  getTopMembers = async (
    { params: { locale, team, email, type } }: Request,
    response: Response
  ) => {
    console.log(
      `[DEBUG] getTeamProgress - locale: ${locale}, team:${team}, email:${email}, type:${type}`
    );
    if (type === 'recorded') {
      response.json({
        team: { name: 'SAP', points: 1000, approved: 50, accuracy: 20.0 },
        member: [
          {
            position: 1,
            name: 'catherine1',
            points: 100,
            approved: 20,
            accuracy: 10.09,
          },
          {
            position: 2,
            name: 'catherine2',
            points: 101,
            approved: 21,
            accuracy: 10.1,
          },
          {
            position: 3,
            name: 'catherine3',
            points: 102,
            approved: 22,
            accuracy: 10.11,
          },
          {
            position: 4,
            name: 'catherine4',
            points: 103,
            approved: 23,
            accuracy: 10.12,
          },
          {
            position: 5,
            name: 'catherine5',
            points: 104,
            approved: 24,
            accuracy: 10.13,
          },
          {
            position: 6,
            name: 'catherine6',
            points: 105,
            approved: 25,
            accuracy: 10.14,
          },
          {
            position: 7,
            name: 'catherine7',
            points: 106,
            approved: 26,
            accuracy: 10.15,
          },
          {
            position: 8,
            name: 'catherine8',
            points: 107,
            approved: 27,
            accuracy: 10.16,
          },
          {
            position: 9,
            name: 'catherine9',
            points: 108,
            approved: 28,
            accuracy: 10.17,
          },
          {
            position: 10,
            name: 'catherine10',
            points: 109,
            approved: 29,
            accuracy: 10.18,
          },
        ],
      });
    } else if (type === 'validated') {
      response.json({
        team: { name: 'SAP', points: 1001, approved: 51, accuracy: 20.01 },
        member: [
          {
            position: 1,
            name: 'can1',
            points: 110,
            approved: 30,
            accuracy: 9.09,
          },
          {
            position: 2,
            name: 'can2',
            points: 111,
            approved: 31,
            accuracy: 9.1,
          },
          {
            position: 3,
            name: 'can3',
            points: 112,
            approved: 32,
            accuracy: 9.11,
          },
          {
            position: 4,
            name: 'can4',
            points: 113,
            approved: 33,
            accuracy: 9.12,
          },
          {
            position: 5,
            name: 'can5',
            points: 114,
            approved: 34,
            accuracy: 9.13,
          },
          {
            position: 6,
            name: 'can6',
            points: 115,
            approved: 35,
            accuracy: 9.14,
          },
          {
            position: 7,
            name: 'can7',
            points: 116,
            approved: 36,
            accuracy: 9.15,
          },
          {
            position: 8,
            name: 'can8',
            points: 117,
            approved: 37,
            accuracy: 9.16,
          },
          {
            position: 9,
            name: 'can9',
            points: 118,
            approved: 38,
            accuracy: 9.17,
          },
          {
            position: 10,
            name: 'can10',
            points: 119,
            approved: 39,
            accuracy: 9.18,
          },
        ],
      });
    } else {
      response.json({});
    }
  };

  getTopTeams = async (
    { params: { locale, type } }: Request,
    response: Response
  ) => {
    console.log(`[DEBUG] getTopTeams - locale: ${locale}, type:${type}`);
    if (type === 'recorded') {
      response.json([
        {
          position: 1,
          name: 'SAP1',
          logo: 'base641...',
          points: 12341,
          approved: 51,
          accuracy: 11.99,
        },
        {
          position: 2,
          name: 'SAP2',
          logo: 'base642...',
          points: 12342,
          approved: 52,
          accuracy: 12.99,
        },
        {
          position: 3,
          name: 'SAP3',
          logo: 'base643...',
          points: 12343,
          approved: 53,
          accuracy: 13.99,
        },
        {
          position: 4,
          name: 'SAP4',
          logo: 'base644...',
          points: 12344,
          approved: 54,
          accuracy: 14.99,
        },
        {
          position: 5,
          name: 'SAP5',
          logo: 'base645...',
          points: 12345,
          approved: 55,
          accuracy: 15.99,
        },
        {
          position: 6,
          name: 'SAP6',
          logo: 'base646...',
          points: 12346,
          approved: 56,
          accuracy: 16.99,
        },
        {
          position: 7,
          name: 'SAP7',
          logo: 'base647...',
          points: 12347,
          approved: 57,
          accuracy: 17.99,
        },
        {
          position: 8,
          name: 'SAP8',
          logo: 'base648...',
          points: 12348,
          approved: 58,
          accuracy: 18.99,
        },
        {
          position: 9,
          name: 'SAP9',
          logo: 'base649...',
          points: 12349,
          approved: 59,
          accuracy: 19.99,
        },
        {
          position: 10,
          name: 'SAP10',
          logo: 'base6410...',
          points: 12340,
          approved: 60,
          accuracy: 20.99,
        },
      ]);
    } else if (type === 'validated') {
      response.json([
        {
          position: 1,
          name: 'SAP11',
          logo: 'base6411...',
          points: 123411,
          approved: 510,
          accuracy: 21.99,
        },
        {
          position: 2,
          name: 'SAP22',
          logo: 'base6422...',
          points: 123422,
          approved: 520,
          accuracy: 22.99,
        },
        {
          position: 3,
          name: 'SAP33',
          logo: 'base6433...',
          points: 123433,
          approved: 530,
          accuracy: 23.99,
        },
        {
          position: 4,
          name: 'SAP44',
          logo: 'base6444...',
          points: 123444,
          approved: 540,
          accuracy: 24.99,
        },
        {
          position: 5,
          name: 'SAP55',
          logo: 'base6455...',
          points: 123455,
          approved: 550,
          accuracy: 25.99,
        },
        {
          position: 6,
          name: 'SAP66',
          logo: 'base6466...',
          points: 123466,
          approved: 560,
          accuracy: 26.99,
        },
        {
          position: 7,
          name: 'SAP77',
          logo: 'base6477...',
          points: 123477,
          approved: 570,
          accuracy: 27.99,
        },
        {
          position: 8,
          name: 'SAP88',
          logo: 'base6488...',
          points: 123488,
          approved: 580,
          accuracy: 28.99,
        },
        {
          position: 9,
          name: 'SAP99',
          logo: 'base6499...',
          points: 123499,
          approved: 590,
          accuracy: 29.99,
        },
        {
          position: 10,
          name: 'SAP100',
          logo: 'base64100...',
          points: 123400,
          approved: 600,
          accuracy: 30.99,
        },
      ]);
    } else {
      response.json({});
    }
  };

  getTopContributors = async (
    { params: { locale, email, type } }: Request,
    response: Response
  ) => {
    console.log(
      `[DEBUG] getTopContributors - locale: ${locale}, email:${email}, type:${type}`
    );
    if (type === 'recorded') {
      response.json([
        {
          position: 1,
          name: 'catherine1',
          logo: 'base641...',
          points: 1231,
          approved: 13,
          accuracy: 11.99,
        },
        {
          position: 1,
          name: 'catherine2',
          logo: 'base642...',
          points: 1232,
          approved: 23,
          accuracy: 12.99,
        },
        {
          position: 1,
          name: 'catherine3',
          logo: 'base643...',
          points: 1233,
          approved: 33,
          accuracy: 13.99,
        },
        {
          position: 1,
          name: 'catherine4',
          logo: 'base644...',
          points: 1234,
          approved: 43,
          accuracy: 14.99,
        },
        {
          position: 1,
          name: 'catherine5',
          logo: 'base645...',
          points: 1235,
          approved: 53,
          accuracy: 15.99,
        },
        {
          position: 1,
          name: 'catherine6',
          logo: 'base646...',
          points: 1236,
          approved: 63,
          accuracy: 16.99,
        },
        {
          position: 1,
          name: 'catherine7',
          logo: 'base647...',
          points: 1237,
          approved: 73,
          accuracy: 17.99,
        },
        {
          position: 1,
          name: 'catherine8',
          logo: 'base648...',
          points: 1238,
          approved: 83,
          accuracy: 18.99,
        },
        {
          position: 1,
          name: 'catherine9',
          logo: 'base649...',
          points: 1239,
          approved: 93,
          accuracy: 19.99,
        },
        {
          position: 1,
          name: 'catherine0',
          logo: 'base640...',
          points: 1230,
          approved: 103,
          accuracy: 20.99,
        },
      ]);
    } else if (type === 'validated') {
      response.json([
        {
          position: 1,
          name: 'catherine11',
          logo: 'base6411...',
          points: 12311,
          approved: 131,
          accuracy: 12.01,
        },
        {
          position: 1,
          name: 'catherine22',
          logo: 'base6422...',
          points: 12322,
          approved: 231,
          accuracy: 12.02,
        },
        {
          position: 1,
          name: 'catherine33',
          logo: 'base6433...',
          points: 12333,
          approved: 331,
          accuracy: 12.03,
        },
        {
          position: 1,
          name: 'catherine44',
          logo: 'base6444...',
          points: 12344,
          approved: 431,
          accuracy: 12.04,
        },
        {
          position: 1,
          name: 'catherine55',
          logo: 'base6455...',
          points: 12355,
          approved: 531,
          accuracy: 12.05,
        },
        {
          position: 1,
          name: 'catherine66',
          logo: 'base6466...',
          points: 12366,
          approved: 631,
          accuracy: 12.06,
        },
        {
          position: 1,
          name: 'catherine77',
          logo: 'base6477...',
          points: 12377,
          approved: 731,
          accuracy: 12.07,
        },
        {
          position: 1,
          name: 'catherine88',
          logo: 'base6488...',
          points: 12388,
          approved: 831,
          accuracy: 12.08,
        },
        {
          position: 1,
          name: 'catherine99',
          logo: 'base6499...',
          points: 12399,
          approved: 931,
          accuracy: 12.09,
        },
        {
          position: 1,
          name: 'catherine00',
          logo: 'base6400...',
          points: 12300,
          approved: 1031,
          accuracy: 12.0,
        },
      ]);
    } else {
      response.json({});
    }
  };
}
