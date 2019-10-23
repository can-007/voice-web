import * as React from 'react';
import { LocaleLink } from '../../../locale-helpers';
import { CircleProgress } from '../../../pages/dashboard/ui';
import { WeeklyChallenge } from '../../../../../../common/challenge';
import URLS from '../../../../urls';
import './weekly-challenge-board.css';

export default function WeeklyChallengeBoard({
  isDisabled,
  title,
  week,
  isNarrow,
  avatarUrl,
  weekly,
}: {
  isDisabled?: boolean;
  title: string;
  week: number;
  isNarrow: boolean;
  avatarUrl: string;
  weekly: WeeklyChallenge;
}) {
  const { user, team } = weekly;
  return (
    <div className={`challenge-board ${isDisabled ? 'disabled' : ''}`}>
      <div className="title-container">
        <div className="icon">
          <img
            src={
              isDisabled
                ? require('./images/stars-disabled.svg')
                : require('./images/stars.svg')
            }
            alt="stars"
          />
        </div>
        <p className="title">{title}</p>
        <div className="week-container">week {++week}</div>
      </div>
      {!isDisabled && (
        <div className="challenge-board-content">
          <div className="content-row">
            <div className="column">
              <img
                src={
                  avatarUrl ? require(avatarUrl) : require('./images/ava.svg')
                }
                alt="Avatar"
              />
              <p>individual</p>
            </div>
            <div className="container">
              <LocaleLink className="speak-btn" to={URLS.SPEAK}>
                Speak
                <span className="speak-icon"></span>
              </LocaleLink>
              {!isNarrow ? (
                <CircleProgress
                  className="speak-bar"
                  value={user.speak}
                  denominator={user.speak_total}
                  strokeW={4}
                  radius={66}
                />
              ) : (
                <div className="fraction speak">
                  <div className="numerator">{user.speak}</div>
                  <div className="denominator"> / {user.speak_total}</div>
                </div>
              )}
            </div>
            <div className="divider" />
            <div className="container">
              <LocaleLink className="listen-btn" to={URLS.LISTEN}>
                Listen
                <span className="listen-icon"></span>
              </LocaleLink>
              {!isNarrow ? (
                <CircleProgress
                  className="listen-bar"
                  value={user.listen}
                  denominator={user.listen_total}
                  strokeW={4}
                  radius={66}
                />
              ) : (
                <div className="fraction listen">
                  <div className="numerator">{user.listen}</div>
                  <div className="denominator"> / {user.listen_total}</div>
                </div>
              )}
            </div>
          </div>
          <div className="content-row">
            <div className="column">
              <img src={require('./images/ava.svg')} alt="team" />
              <p>Team</p>
            </div>
            <div className="container team">
              <p className="team-text">
                Win a prize by being the team with the highest sign up rate
              </p>
              <div className="v-divider" />
              <p className="team-invite">
                The is the percentage of team invites that have been accepted
                out of the current total sent.
              </p>
            </div>
            <div className="container invite">
              {!isNarrow ? (
                <CircleProgress
                  className="team-bar"
                  value={team.invite / team.invite_total}
                  strokeW={4}
                  radius={66}
                />
              ) : (
                <React.Fragment>
                  <div className="team-invite-percentage">
                    <span>{team.invite / team.invite_total}</span>%
                  </div>
                  <div className="divider"></div>
                </React.Fragment>
              )}
              <p className="team-invite-total">
                of {team.invite_total} invites
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
